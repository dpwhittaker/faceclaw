import { shouldShowNotificationOnGlasses } from "../../native/notification-sources";
import { onAnySettingChanged } from "../../ui/dashboard-settings";
import { postAmbientCard } from "../../ui/shell/ambient-cards";
import { shell } from "../../ui/shell/shell";
import { CueChannel, type CueChannelEvents, type CueChannelStatus, type CueEntryFrame, type CueMemoryUpdate, type CueRecentPerson, type CueTriage } from "./cue-channel";
import { CueCalendarSync } from "./cue-calendar-sync";
import { CueRecordings } from "./cue-recordings";
import { cueBackendTokenSetting, cueBackendUrlSetting, cueOrgFor } from "./cue-settings";
import { CueTermuxSupervisor } from "./cue-termux";
import { androidCueTransport } from "./cue-transport";
import { CueVoices } from "./cue-voices";
import { EntryPopupLayer, type EntryPopup } from "./entry-layer";
import { notificationId, routeNotification, type FeedNotification } from "./meeting-notifications";
import { BACK, applyLocally, cueLine, entryOptions, type EntryCategory, type EntryOption, type Notebook, type NotebookEntry } from "./notebook-view";
import { parseResponses, type NotificationResponse, type ParsedResponses } from "./notification-responses";

declare const com: any;

/**
 * Cue's always-on half, started when Faceclaw starts: the connection to
 * Cue's backend, and every notification. Meetings go onto the Work
 * calendar; everything else goes to the backend's triage, and the urgent
 * ones pop up over whatever app is in front, as do the urgent cues Claude
 * gives during a conversation. A notification's pop-up also offers what
 * the notification itself offers (Mark as read...), and for one you'd
 * answer by typing, the three replies Claude suggests (asked for when the
 * pop-up opens, unless triage already had them made).
 * Faceclaw's own notification pop-ups stay off while this runs; if triage
 * hasn't answered within TRIAGE_WAIT_MS (backend down), the message pops up
 * plainly instead. The Cue window's conversations use the same connection,
 * and recordings of finished conversations are handed off from here, Cue
 * open or not.
 */

const TRIAGE_WAIT_MS = 60_000;
const SEEN_KEPT = 500;

/** What the Cue window's conversation half listens for. */
export type CueConversationHandler = Pick<CueChannelEvents, "onEndContext" | "onAnswer" | "onContextAck" | "onSpeaker">;

const MEMORY_CARD_SECONDS = 10;

class CueLink {
  readonly channel = new CueChannel(androidCueTransport, this.events());
  readonly voices = new CueVoices((contextId, speaker, seconds, scores, startMs, endMs) => this.channel.voiceprint(contextId, speaker, seconds, scores, startMs, endMs));
  readonly recordings = new CueRecordings(() => this.voices.store());
  private started = false;
  private config = "";
  private status: CueChannelStatus = "offline";
  private detail = "";
  private recentPeople: CueRecentPerson[] = [];
  private books: Notebook[] = [];
  private conversation: CueConversationHandler | null = null;
  private memory: CueMemoryUpdate | null = null;
  private screen: { columns: number; lines: number } | null = null;
  private readonly listeners = new Set<() => void>();
  // Notifications sent to triage, by id, until it answers (or the wait runs out).
  private readonly waiting = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly seen = new Set<string>();
  // Android's key for each notification sent to triage, by id, for its responses.
  private readonly keys = new Map<string, string>();
  // Claude's suggested replies by notification id, and the ids they've been asked for.
  private readonly suggested = new Map<string, string[]>();
  private readonly askedReplies = new Set<string>();
  private feedListener: any = null;
  private readonly calendar = new CueCalendarSync();
  private readonly termux = new CueTermuxSupervisor(() => this.status === "connected", (detail) => this.setDetail(detail));

  start(): void {
    if (this.started || !global.isAndroid) return;
    this.started = true;
    this.connect();
    onAnySettingChanged(() => this.connect());
    this.feedListener = new com.faceclaw.app.FaceclawNotificationFeed.Listener({
      onNotification: (json: string) => {
        try {
          this.onNotification(JSON.parse(String(json)));
        } catch (error) {
          console.warn(`[Cue] bad notification from the feed: ${String(error)}`);
        }
      },
    });
    com.faceclaw.app.FaceclawNotificationFeed.addListener(this.feedListener);
    this.termux.start();
    this.calendar.start();
    this.recordings.resume();
  }

  /** While Cue handles notifications, Faceclaw's own notification pop-ups stay off. */
  suppressesNotificationPopups(): boolean {
    return this.started && Boolean(cueBackendUrlSetting.get() && cueBackendTokenSetting.get());
  }

  get backendStatus(): CueChannelStatus {
    return this.status;
  }

  get backendDetail(): string {
    return this.detail;
  }

  get recent(): CueRecentPerson[] {
    return this.recentPeople;
  }

  get notebooks(): Notebook[] {
    return this.books;
  }

  /** The last memory update this session, until it's undone. */
  get lastMemoryUpdate(): CueMemoryUpdate | null {
    return this.memory;
  }

  /** Undoes the last memory update (the backend reverts its commit and sends the notebooks again). */
  undoMemoryUpdate(): void {
    if (!this.memory) return;
    this.channel.review(this.memory.commit);
    this.memory = null;
    this.notify();
  }

  setConversationHandler(handler: CueConversationHandler | null): void {
    this.conversation = handler;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Dismisses or moves an entry (the glasses update at once and the backend
   * confirms), or sends one of its notification's responses and says how
   * that went.
   */
  act(notebook: string, entry: NotebookEntry, option: EntryOption): string | void {
    if (option.action === "respond" && option.response) return respond(option.response);
    if (option.action !== "dismiss" && option.action !== "move") return;
    this.books = applyLocally(this.books, notebook, entry.id, option);
    this.channel.entry(notebook, entry.id, option.action, option.to);
    this.notify();
  }

  /** The main screen's size, sent when it changes (a display mode or font switch). */
  setScreen(columns: number, lines: number): void {
    if (this.screen?.columns === columns && this.screen.lines === lines) return;
    this.screen = { columns, lines };
    this.channel.screen(columns, lines);
  }

  /** Dismiss all: every status message of these notebooks. */
  clearStatus(notebooks: string[]): void {
    this.books = this.books.map((book) => (notebooks.includes(book.name) ? { ...book, status: [], statusCount: 0 } : book));
    for (const notebook of notebooks) this.channel.statusClear(notebook);
    this.notify();
  }

  /** The pop-up for an entry: Back, its category's options, its notification's responses, then any extra options. */
  entryPopup(notebook: Notebook, entry: NotebookEntry, extra: EntryOption[] = []): EntryPopup {
    const heading = entry.title ? `${entry.title} · ${notebook.label}` : notebook.label;
    const body = entry.contextId ? [cueLine(entry), entry.body].filter(Boolean).join("\n") : entry.body || entry.text;
    return this.livePopup(entry.category, heading, body, () => [...entryOptions(entry.category), ...this.responses(entry.nid), ...extra]);
  }

  /** A pop-up whose options are made again, and repainted, whenever Cue's state changes (suggested replies arriving). */
  private livePopup(category: EntryCategory | null, heading: string, body: string, options: () => EntryOption[]): EntryPopup {
    let made: EntryOption[] | null = null;
    return {
      category,
      heading,
      body,
      get options() {
        return (made ??= options());
      },
      onChange: (listener) => this.onChange(() => {
        made = null;
        listener();
      }),
    };
  }

  /**
   * What a notification offers to send back, as options. One you'd answer
   * by typing gets Claude's suggested replies, asked for the first time
   * it's shown.
   */
  private responses(nid: string | null): EntryOption[] {
    const key = nid ? this.keys.get(nid) : undefined;
    if (!nid || !key) return [];
    const { responses, typed } = readResponses(key, this.suggested.get(nid) ?? []);
    if (typed && !this.suggested.has(nid) && !this.askedReplies.has(nid)) {
      this.askedReplies.add(nid);
      this.channel.suggestReplies(nid);
    }
    return responses.map((response) => ({ label: response.label, action: "respond", response }));
  }

  private connect(): void {
    const url = cueBackendUrlSetting.get();
    const token = cueBackendTokenSetting.get();
    const config = `${url}\n${token}`;
    if (config === this.config) return;
    const wasRunning = Boolean(this.config.trim());
    this.config = config;
    if (!url || !token) {
      this.channel.stop();
      this.setDetail("Set Cue's backend address and token in Cue's settings.");
      return;
    }
    if (wasRunning) this.channel.retarget(url, token);
    else this.channel.start(url, token, newId(), cueOrgFor(null, Date.now()));
  }

  private onNotification(notification: FeedNotification): void {
    const route = routeNotification(notification);
    if (route.kind === "meeting") {
      this.calendar.handle(route.meeting);
      return;
    }
    if (route.kind === "ignore" || !shouldShowNotificationOnGlasses(notification.package)) return;
    const nid = notificationId(notification);
    this.keys.set(nid, notification.key);
    if (this.keys.size > SEEN_KEPT) this.keys.delete(this.keys.keys().next().value as string);
    if (this.seen.has(nid)) return;
    this.seen.add(nid);
    if (this.seen.size > SEEN_KEPT) this.seen.delete(this.seen.values().next().value as string);
    if (!this.suppressesNotificationPopups()) return;
    this.channel.notification({
      nid,
      package: notification.package,
      app: notification.app,
      profile: notification.profile,
      postedMs: notification.postTime,
      title: notification.conversationTitle || notification.title,
      text: notification.text,
      bigText: notification.bigText,
      subText: notification.subText,
      lines: notification.lines,
      messages: notification.messages,
      canReply: notification.replyable === true,
    });
    this.waiting.set(nid, setTimeout(() => {
      this.waiting.delete(nid);
      // Triage didn't answer: show it the plain way rather than lose it.
      const body = notification.messages.length
        ? notification.messages.map((message) => `${message.sender ? `${message.sender}: ` : ""}${message.text}`).join("\n")
        : notification.bigText || notification.text;
      this.popUp(this.livePopup(null, `${notification.title} · ${notification.app}`, body, () => [BACK, ...this.responses(nid)]), (option) =>
        (option.response ? respond(option.response) : undefined));
    }, TRIAGE_WAIT_MS));
  }

  private onTriage(triage: CueTriage): void {
    const timer = this.waiting.get(triage.nid);
    if (timer !== undefined) clearTimeout(timer);
    this.waiting.delete(triage.nid);
    if (triage.category !== "urgent") return;
    const heading = [triage.title, triage.app].filter(Boolean).join(" · ") || triage.line;
    this.popUpEntry(triage.notebook, { id: triage.entryId, category: "urgent", text: triage.line, nid: triage.nid, title: triage.title, body: triage.body, contextId: null }, heading, triage.body || triage.line);
  }

  /** A cue from the conversation: an urgent one pops up like an urgent message. */
  private onCue(cue: CueEntryFrame): void {
    if (cue.category !== "urgent") return;
    this.popUpEntry(cue.notebook, { id: cue.entryId, category: "urgent", text: cue.line, nid: null, title: cue.title, body: cue.detail, contextId: cue.contextId }, cue.line, cue.detail || cue.title);
  }

  /** An entry that just arrived, over whatever app is in front; acted on as the notebooks have it by then. */
  private popUpEntry(notebook: string, arrived: Pick<NotebookEntry, "id" | "category" | "text" | "nid" | "title" | "body" | "contextId">, heading: string, body: string): void {
    const category = arrived.category as EntryCategory;
    this.popUp(this.livePopup(category, heading, body, () => [...entryOptions(category), ...this.responses(arrived.nid)]), (option) => {
      const entry = this.books.find((book) => book.name === notebook)?.entries.find((candidate) => candidate.id === arrived.id)
        ?? { ...arrived, section: "day", day: null, firstCategory: category };
      return this.act(notebook, entry, option);
    });
  }

  /** A pop-up over whatever app is in front. */
  private popUp(popup: EntryPopup, choose: (option: EntryOption) => string | void): void {
    let close = () => {};
    close = shell.openModal(new EntryPopupLayer(popup, choose, () => close()));
  }

  private events(): CueChannelEvents {
    return {
      onStatus: (status, detail) => {
        if (status === "connected" && this.status !== "connected") this.recordings.retryNow();
        this.status = status;
        this.setDetail(detail);
      },
      onRecent: (recent) => {
        this.recentPeople = recent;
        this.notify();
      },
      onCue: (cue) => this.onCue(cue),
      onEndContext: (contextId, reason) => this.conversation?.onEndContext(contextId, reason),
      onAnswer: (askId, text, done) => this.conversation?.onAnswer(askId, text, done),
      onTriage: (triage) => this.onTriage(triage),
      onReplies: (nid, replies) => this.setSuggested(nid, replies),
      onNotebooks: (notebooks) => {
        this.books = notebooks as Notebook[];
        for (const book of this.books) {
          for (const entry of [...book.entries, ...book.status]) if (entry.nid && entry.replies?.length) this.setSuggested(entry.nid, entry.replies, false);
        }
        this.notify();
      },
      onContextAck: (contextId, candidates) => this.conversation?.onContextAck(contextId, candidates),
      onSpeaker: (speaker) => this.conversation?.onSpeaker(speaker),
      onMemoryUpdated: (update) => {
        this.memory = update;
        const changed = update.files.map(notebookLabel);
        console.log(`[Cue] memory updated (${update.commit}): ${changed.join(", ")}`);
        postAmbientCard({
          id: "cue:memory",
          title: "Cue remembered",
          lines: [changed.join(", ") || "No notebooks changed", "Undo it in Cue's menu"],
          expiresAtMs: Date.now() + MEMORY_CARD_SECONDS * 1000,
        });
        this.notify();
      },
    };
  }

  private setSuggested(nid: string, replies: string[], notify = true): void {
    if (!replies.length) return;
    this.suggested.set(nid, replies);
    if (this.suggested.size > SEEN_KEPT) this.suggested.delete(this.suggested.keys().next().value as string);
    if (notify) this.notify();
  }

  private setDetail(detail: string): void {
    this.detail = detail;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** "people/priya/notebook.md" → "priya"; "orgs/work/teams/payments/notebook.md" → "payments". */
function notebookLabel(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 2] ?? path;
}

function readResponses(key: string, claude: readonly string[]): ParsedResponses {
  if (!global.isAndroid) return { responses: [], typed: false };
  try {
    return parseResponses(key, String(com.faceclaw.app.FaceclawNotificationFeed.responses(key)), claude);
  } catch (error) {
    console.warn(`[Cue] couldn't read a notification's responses: ${String(error)}`);
    return { responses: [], typed: false };
  }
}

/** Sends a notification's response; says how it went, for the pop-up. */
function respond(response: NotificationResponse): string {
  try {
    if (com.faceclaw.app.FaceclawNotificationFeed.respond(response.key, response.index, response.reply)) return `Sent: ${response.label}`;
  } catch (error) {
    console.warn(`[Cue] couldn't send a notification response: ${String(error)}`);
  }
  return "Couldn't send it: the notification is gone.";
}

function newId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export const cueLink = new CueLink();
