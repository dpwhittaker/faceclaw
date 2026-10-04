import { shouldShowNotificationOnGlasses } from "../../native/notification-sources";
import { onAnySettingChanged } from "../../ui/dashboard-settings";
import { postAmbientCard } from "../../ui/shell/ambient-cards";
import { shell } from "../../ui/shell/shell";
import { CueChannel, type CueChannelEvents, type CueChannelStatus, type CueMemoryUpdate, type CueRecentPerson, type CueTriage } from "./cue-channel";
import { CueCalendarSync } from "./cue-calendar-sync";
import { CueRecordings } from "./cue-recordings";
import { cueBackendTokenSetting, cueBackendUrlSetting, cueOrgFor } from "./cue-settings";
import { CueTermuxSupervisor } from "./cue-termux";
import { androidCueTransport } from "./cue-transport";
import { CueVoices } from "./cue-voices";
import { EntryPopupLayer, type EntryPopup } from "./entry-layer";
import { notificationId, routeNotification, type FeedNotification } from "./meeting-notifications";
import { applyLocally, entryOptions, type EntryOption, type Notebook, type NotebookEntry } from "./notebook-view";

declare const com: any;

/**
 * Cue's always-on half, started when Faceclaw starts: the connection to
 * Cue's backend, and every notification. Meetings go onto the Work
 * calendar; everything else goes to the backend's triage, and the urgent
 * ones pop up over whatever app is in front. Faceclaw's own notification
 * pop-ups stay off while this runs; if triage hasn't answered within
 * TRIAGE_WAIT_MS (backend down), the message pops up plainly instead.
 * The Cue window's conversations use the same connection, and recordings
 * of finished conversations are handed off from here, Cue open or not.
 */

const TRIAGE_WAIT_MS = 60_000;
const SEEN_KEPT = 500;

/** What the Cue window's conversation half listens for. */
export type CueConversationHandler = Pick<CueChannelEvents, "onList" | "onPopup" | "onEndContext" | "onAnswer" | "onContextAck" | "onSpeaker">;

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
  private readonly listeners = new Set<() => void>();
  // Notifications sent to triage, by id, until it answers (or the wait runs out).
  private readonly waiting = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly seen = new Set<string>();
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

  /** Dismisses or moves an entry; the glasses update at once and the backend confirms. */
  act(notebook: string, entry: NotebookEntry, option: EntryOption): void {
    if (option.action === "keep") return;
    this.books = applyLocally(this.books, notebook, entry.id, option);
    this.channel.entry(notebook, entry.id, option.action, option.to);
    this.notify();
  }

  /** Dismiss all: every status message of these notebooks. */
  clearStatus(notebooks: string[]): void {
    this.books = this.books.map((book) => (notebooks.includes(book.name) ? { ...book, status: [], statusCount: 0 } : book));
    for (const notebook of notebooks) this.channel.statusClear(notebook);
    this.notify();
  }

  /** The pop-up for an entry, with its category's options. */
  entryPopup(notebook: Notebook, entry: NotebookEntry): EntryPopup {
    const heading = entry.title ? `${entry.title} · ${notebook.label}` : notebook.label;
    return { category: entry.category, heading, body: entry.body || entry.text, options: entryOptions(entry.category) };
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
    });
    this.waiting.set(nid, setTimeout(() => {
      this.waiting.delete(nid);
      // Triage didn't answer: show it the plain way rather than lose it.
      const body = notification.messages.length
        ? notification.messages.map((message) => `${message.sender ? `${message.sender}: ` : ""}${message.text}`).join("\n")
        : notification.bigText || notification.text;
      this.popUp({ category: null, heading: `${notification.title} · ${notification.app}`, body, options: [{ label: "OK", action: "keep" }] }, () => {});
    }, TRIAGE_WAIT_MS));
  }

  private onTriage(triage: CueTriage): void {
    const timer = this.waiting.get(triage.nid);
    if (timer !== undefined) clearTimeout(timer);
    this.waiting.delete(triage.nid);
    if (triage.category !== "urgent") return;
    const heading = [triage.title, triage.app].filter(Boolean).join(" · ") || triage.line;
    this.popUp({ category: "urgent", heading, body: triage.body || triage.line, options: entryOptions("urgent") }, (option) => {
      const entry = this.books.find((book) => book.name === triage.notebook)?.entries.find((candidate) => candidate.id === triage.entryId)
        ?? { id: triage.entryId, section: "day", day: null, category: "urgent", firstCategory: "urgent", text: triage.line, nid: triage.nid, title: triage.title, body: triage.body } as NotebookEntry;
      this.act(triage.notebook, entry, option);
    });
  }

  /** A pop-up over whatever app is in front. */
  private popUp(popup: EntryPopup, choose: (option: EntryOption) => void): void {
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
      onList: (contextId, items) => this.conversation?.onList(contextId, items),
      onPopup: (popup) => this.conversation?.onPopup(popup),
      onEndContext: (contextId, reason) => this.conversation?.onEndContext(contextId, reason),
      onAnswer: (askId, text, done) => this.conversation?.onAnswer(askId, text, done),
      onTriage: (triage) => this.onTriage(triage),
      onNotebooks: (notebooks) => {
        this.books = notebooks as Notebook[];
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

function newId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export const cueLink = new CueLink();
