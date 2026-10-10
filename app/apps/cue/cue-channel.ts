/**
 * The phone's end of the cue protocol: a websocket to Cue's backend that
 * survives drops. Transcript lines are kept until the backend acks their seq
 * and are resent after a reconnect; other frames queue while offline. A
 * reconnect resumes the session; if the backend has lost it (restarted), the
 * channel starts a new session and re-announces the current context.
 *
 * Pure: the websocket and the timer are injected, so it runs under node tests.
 */

export type CueTransport = { send(text: string): boolean; close(): void };
export type CueTransportHandlers = { onOpen(): void; onMessage(text: string): void; onClose(reason: string): void };
export type CueTransportFactory = (url: string, token: string, handlers: CueTransportHandlers) => CueTransport;

export type CueChannelStatus = "offline" | "connecting" | "connected";

export type CueEventFrame = {
  key: string;
  seriesKey: string;
  title: string;
  start: number;
  end: number;
  calendar: string;
  location: string;
  description: string;
  attendees: { name: string; email: string; type: string; self: boolean }[];
};

export type CueSwitchFrame = {
  atMs: number;
  contextId: string | null;
  kind?: "scheduled" | "adhoc";
  event?: CueEventFrame;
  people?: { personId: string; name: string }[];
  org?: string;
  team?: string;
};

export type CueRecentPerson = { personId: string; name: string; team: string; lastTalked: number };
/** A cue Claude filed during a conversation (an entry in the notebook, like a notification's); urgent ones pop up. */
export type CueEntryFrame = { contextId: string; notebook: string; entryId: string; category: "urgent" | "todo" | "status"; line: string; title: string; detail: string };
/** A notification the backend's triage filed. */
export type CueTriage = { nid: string; category: "urgent" | "todo" | "status"; notebook: string; entryId: string; line: string; title: string; body: string; app: string };

/** Someone who might be speaking in a context: 1 a participant, 2 on their teams, 3 in the organization. */
export type CueCandidate = { personId: string; name: string; tier: number };
/** The backend's name for one of a context's voices; unconfirmed ones show as "Dana?". */
export type CueSpeaker = { contextId: string; speaker: string; personId: string | null; name: string; confidence: string; confirmed: boolean };
/** A voice-print's similarity to one candidate ("you" is the wearer). */
export type CueVoiceScore = { personId: string; similarity: number };
/** A memory run committed: which notebooks changed, and the speakers it couldn't name. */
export type CueMemoryUpdate = { contextId: string; commit: string; files: string[]; unknowns: { speaker: string; maybe: string | null }[] };

/** A notification as the backend's triage takes it. */
export type CueNotificationFrame = {
  nid: string;
  package: string;
  app: string;
  profile: number;
  postedMs: number;
  title: string;
  text: string;
  bigText: string;
  subText: string;
  lines: string[];
  messages: { sender: string; text: string; time: number }[];
  /** It has a reply field you'd type into: Claude suggests replies. */
  canReply: boolean;
};

export type CueChannelEvents = {
  onStatus(status: CueChannelStatus, detail: string): void;
  onRecent(recent: CueRecentPerson[]): void;
  onCue(cue: CueEntryFrame): void;
  onEndContext(contextId: string, reason: string): void;
  onAnswer(askId: string, text: string, done: boolean): void;
  onTriage(triage: CueTriage): void;
  /** Claude's suggested replies to a message. */
  onReplies(nid: string, replies: string[]): void;
  /** The backend's notebooks (the frame's `notebooks` array, as sent). */
  onNotebooks(notebooks: unknown[]): void;
  /** The backend took a context: who might be speaking in it. */
  onContextAck(contextId: string, candidates: CueCandidate[]): void;
  onSpeaker(speaker: CueSpeaker): void;
  onMemoryUpdated(update: CueMemoryUpdate): void;
};

type Frame = { type: string; [key: string]: unknown };
type Line = { seq: number; contextId: string; speaker: string; text: string; startMs: number; endMs: number };

const MAX_UNACKED_LINES = 2000;
const MAX_QUEUED_FRAMES = 200;
const MAX_BACKOFF_MS = 30_000;

export class CueChannel {
  private url = "";
  private token = "";
  private sessionId = "";
  private org = "";
  private started = false;
  private status: CueChannelStatus = "offline";
  private transport: CueTransport | null = null;
  // "resuming" between sending resume and the backend's ack of it.
  private phase: "resuming" | "ready" = "ready";
  // Whether some connection has sent session-start for this session.
  private announced = false;
  private seq = 0;
  private unacked: Line[] = [];
  private queued: Frame[] = [];
  // The current context's switch, re-sent when a restarted backend needs it.
  private currentSwitch: CueSwitchFrame | null = null;
  private attempt = 0;
  private retry: unknown = null;
  private generation = 0;

  constructor(
    private readonly connect: CueTransportFactory,
    private readonly events: CueChannelEvents,
    private readonly schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    private readonly cancel: (handle: unknown) => void = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  ) {}

  start(url: string, token: string, sessionId: string, org: string): void {
    this.stop();
    Object.assign(this, { url, token, sessionId, org, started: true, announced: false, seq: 0, attempt: 0 });
    this.open();
  }

  stop(): void {
    if (this.started && this.status === "connected") this.write({ type: "session-end", reason: "stopped" });
    this.started = false;
    this.generation += 1;
    if (this.retry !== null) this.cancel(this.retry);
    this.retry = null;
    this.transport?.close();
    this.transport = null;
    this.unacked = [];
    this.queued = [];
    this.currentSwitch = null;
    this.setStatus("offline", "");
  }

  switchTo(frame: CueSwitchFrame): void {
    this.currentSwitch = frame.contextId ? frame : null;
    this.enqueue({ type: "switch", ...frame });
  }

  contextEnd(contextId: string, atMs: number, reason: string): void {
    if (this.currentSwitch?.contextId === contextId) this.currentSwitch = null;
    this.enqueue({ type: "context-end", contextId, atMs, reason });
  }

  line(contextId: string, speaker: string, text: string, startMs: number, endMs: number): void {
    if (!this.started) return;
    const line: Line = { seq: this.seq++, contextId, speaker, text, startMs, endMs };
    this.unacked.push(line);
    // A long outage drops the oldest lines; the recording still has them.
    if (this.unacked.length > MAX_UNACKED_LINES) this.unacked.splice(0, this.unacked.length - MAX_UNACKED_LINES);
    if (this.ready()) this.write(lineFrame(line));
  }

  ask(contextId: string, askId: string, itemId: string | undefined, text: string): void {
    this.enqueue({ type: "ask", contextId, askId, itemId, text });
  }

  notification(notification: CueNotificationFrame): void {
    this.enqueue({ type: "notification", ...notification });
  }

  entry(notebook: string, entryId: string, action: "dismiss" | "move", to?: string): void {
    this.enqueue({ type: "entry", notebook, entryId, action, to });
  }

  /** Asks for Claude's suggested replies to a message, now. */
  suggestReplies(nid: string): void {
    this.enqueue({ type: "suggest-replies", nid });
  }

  statusClear(notebook: string): void {
    this.enqueue({ type: "status-clear", notebook });
  }

  /** One run of a voice (startMs to endMs), scored against the context's candidates. */
  voiceprint(contextId: string, speaker: string, seconds: number, scores: CueVoiceScore[], startMs?: number, endMs?: number): void {
    this.enqueue({ type: "voiceprint", contextId, speaker, seconds: Math.round(seconds * 10) / 10, scores, startMs, endMs });
  }

  /** The live transcription restarted: its voice numbers started over. */
  voicesReset(contextId: string, atMs: number): void {
    this.enqueue({ type: "voices-reset", contextId, atMs });
  }

  /** The wearer says who a voice is: a known person, or a new name. */
  correctSpeaker(contextId: string, speaker: string, personId: string | null, name?: string): void {
    this.enqueue({ type: "correct-speaker", contextId, speaker, personId: personId ?? undefined, name });
  }

  /** Undoes a memory update. */
  review(commit: string): void {
    this.enqueue({ type: "review", commit, action: "revert" });
  }

  /**
   * Points the channel at another backend address or token, keeping what's
   * waiting and the current context, which the new connection announces in
   * a fresh session.
   */
  retarget(url: string, token: string): void {
    if (!this.started) return;
    Object.assign(this, { url, token, announced: false, attempt: 0 });
    if (this.retry !== null) this.cancel(this.retry);
    this.retry = null;
    this.open();
  }

  private ready(): boolean {
    return this.status === "connected" && this.phase === "ready";
  }

  private open(): void {
    if (!this.started) return;
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.transport?.close();
    this.transport = null;
    this.setStatus("connecting", "Connecting to Cue's backend...");
    try {
      this.transport = this.connect(this.url, this.token, {
        onOpen: () => {
          if (!current()) return;
          this.attempt = 0;
          this.setStatus("connected", "");
          if (this.announced) {
            this.phase = "resuming";
            this.write({ type: "resume", lastAckedSeq: (this.unacked[0]?.seq ?? this.seq) - 1 });
          } else {
            this.announce();
          }
        },
        onMessage: (text) => { if (current()) this.receive(text); },
        onClose: (reason) => { if (current()) this.lost(reason); },
      });
    } catch (error) {
      this.lost(String((error as Error)?.message ?? error));
    }
  }

  /** Starts the session on the backend, re-announces the current context, then sends everything waiting. */
  private announce(): void {
    this.announced = true;
    this.phase = "ready";
    this.write({ type: "session-start", org: this.org });
    const queued = this.queued.splice(0);
    if (this.currentSwitch && !queued.some((frame) => frame.type === "switch")) this.write({ type: "switch", ...this.currentSwitch });
    this.flush(queued);
  }

  private flush(frames: Frame[]): void {
    for (const frame of frames) this.write(frame);
    for (const line of this.unacked) this.write(lineFrame(line));
  }

  private receive(text: string): void {
    let frame: any;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    switch (frame?.type) {
      case "ack": {
        const seq = Number(frame.seq);
        this.unacked = this.unacked.filter((line) => line.seq > seq);
        if (this.phase === "resuming") {
          // The reply to resume: resend what the backend doesn't have.
          this.phase = "ready";
          this.flush(this.queued.splice(0));
        }
        return;
      }
      case "session-ack":
        this.events.onRecent(Array.isArray(frame.recent) ? frame.recent : []);
        return;
      case "cue":
        this.events.onCue({
          contextId: String(frame.contextId),
          notebook: String(frame.notebook ?? ""),
          entryId: String(frame.entryId ?? ""),
          category: frame.category === "urgent" || frame.category === "todo" ? frame.category : "status",
          line: String(frame.line ?? ""),
          title: String(frame.title ?? ""),
          detail: String(frame.detail ?? ""),
        });
        return;
      case "end-context":
        this.events.onEndContext(String(frame.contextId), String(frame.reason ?? ""));
        return;
      case "answer":
        this.events.onAnswer(String(frame.askId), String(frame.text ?? ""), Boolean(frame.done));
        return;
      case "triage":
        this.events.onTriage({
          nid: String(frame.nid),
          category: frame.category === "urgent" || frame.category === "todo" ? frame.category : "status",
          notebook: String(frame.notebook ?? ""),
          entryId: String(frame.entryId ?? ""),
          line: String(frame.line ?? ""),
          title: String(frame.title ?? ""),
          body: String(frame.body ?? ""),
          app: String(frame.app ?? ""),
        });
        return;
      case "replies":
        this.events.onReplies(String(frame.nid), Array.isArray(frame.replies) ? frame.replies.map(String) : []);
        return;
      case "notebooks":
        this.events.onNotebooks(Array.isArray(frame.notebooks) ? frame.notebooks : []);
        return;
      case "context-ack":
        this.events.onContextAck(String(frame.contextId), Array.isArray(frame.candidates)
          ? frame.candidates.map((c: any) => ({ personId: String(c.personId), name: String(c.name ?? c.personId), tier: Number(c.tier) || 3 }))
          : []);
        return;
      case "speaker":
        this.events.onSpeaker({
          contextId: String(frame.contextId),
          speaker: String(frame.speaker),
          personId: frame.personId ? String(frame.personId) : null,
          name: String(frame.name ?? ""),
          confidence: String(frame.confidence ?? "low"),
          confirmed: Boolean(frame.confirmed),
        });
        return;
      case "memory-updated":
        this.events.onMemoryUpdated({
          contextId: String(frame.contextId),
          commit: String(frame.commit),
          files: Array.isArray(frame.files) ? frame.files.map(String) : [],
          unknowns: Array.isArray(frame.unknowns) ? frame.unknowns : [],
        });
        return;
      case "error":
        // A restarted backend has forgotten the session: start it again.
        if (this.phase === "resuming" && /unknown session/.test(String(frame.message))) this.announce();
        else this.events.onStatus(this.status, `Cue's backend: ${String(frame.message ?? "error")}`);
        return;
      default:
        return;
    }
  }

  private lost(reason: string): void {
    this.transport = null;
    // A socket can report both a failure and a close; retry once.
    if (!this.started || this.retry !== null) return;
    const delay = Math.min(1000 * 2 ** Math.min(this.attempt++, 5), MAX_BACKOFF_MS);
    this.setStatus("offline", `Cue's backend is unreachable (${reason}); retrying in ${Math.round(delay / 1000)}s.`);
    this.retry = this.schedule(() => {
      this.retry = null;
      this.open();
    }, delay);
  }

  private enqueue(frame: Frame): void {
    if (!this.started) return;
    if (this.ready()) {
      this.write(frame);
      return;
    }
    this.queued.push(frame);
    if (this.queued.length > MAX_QUEUED_FRAMES) this.queued.splice(0, this.queued.length - MAX_QUEUED_FRAMES);
  }

  private write(frame: Frame): void {
    const sent = this.transport?.send(JSON.stringify({ ...frame, sessionId: this.sessionId })) ?? false;
    // Lines wait in `unacked` anyway; anything else waits for the reconnect.
    if (!sent && frame.type !== "line" && frame.type !== "resume" && frame.type !== "session-start") this.queued.push(frame);
  }

  private setStatus(status: CueChannelStatus, detail: string): void {
    this.status = status;
    this.events.onStatus(status, detail);
  }
}

function lineFrame(line: Line): Frame {
  return { type: "line", contextId: line.contextId, seq: line.seq, speaker: line.speaker, text: line.text, startMs: line.startMs, endMs: line.endMs };
}
