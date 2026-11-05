import { GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { voiceControlBridge, type VoiceTranscriptEvent } from "../../native/voice-control";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext, type LayerStack } from "../../ui/layers";
import { type MenuItem } from "../../ui/menu";
import { clamp } from "../../util/numeric-util";
import { ScriptTracker } from "../teleprompter/script-tracker";
import { type MuseDocument } from "./core/document";
import { layoutDocument, type MuseLayout } from "./core/document-layout";
import { type Size, type Staves } from "./core/engrave";
import { type ClefChoice, type MuseSettings } from "./core/front-matter";
import { museFont, museFontKey } from "./fonts";

const MARGIN_X = 8;
const RENDER_TICK_MS = 30;
/** How fast a voice-follow move closes on its target: ~63% of the way in this many seconds. */
const FOLLOW_TAU_S = 0.18;
const MODE_KEY = "muse.mode";
const SPEED_KEY = "muse.speedPxPerSec";
const SPEEDS = [16, 28, 44, 70] as const;
const SPEED_LABELS = ["Slow", "Medium", "Brisk", "Fast"];
const DEFAULT_SPEED = 28;
export const TEXT_SIZES: readonly number[] = [14, 16, 18, 20, 24, 28, 32, 40];
const SIZES: readonly Size[] = ["small", "medium", "large"];
const STAVES: readonly Staves[] = [6, 4];
const CLEFS: readonly ClefChoice[] = ["auto", "bass", "treble"];
const CLEF_LABELS: Record<ClefChoice, string> = { auto: "as written", bass: "bass", treble: "treble" };

/** Follow the reader's voice, or scroll at a steady speed. */
type Mode = "voice" | "auto";

export type MuseReaderHooks = {
  requestRender: () => void;
  /** Hold continuous mic capture while following the voice. */
  startCapture: () => void;
  stopCapture: () => void;
  /** The reader closed (or paused) at this word. */
  savePosition: (position: number) => void;
  /** Sizes or clef changed: keep them with the file. */
  saveSettings: (settings: MuseSettings) => void;
};

function loadMode(): Mode {
  return getStringSetting(MODE_KEY, "voice") === "auto" ? "auto" : "voice";
}

function loadSpeed(): number {
  const parsed = parseInt(getStringSetting(SPEED_KEY, String(DEFAULT_SPEED)), 10);
  return SPEEDS.includes(parsed as (typeof SPEEDS)[number]) ? parsed : DEFAULT_SPEED;
}

/**
 * Muse's reading view: the document as a column of row images (a line of
 * text, a system of music), scrolled smoothly. Following the voice, the
 * live transcript moves a ScriptTracker through the document's words (text
 * and lyrics alike), and the view glides to keep the next word a third of
 * the way down, underlined. Auto-scroll moves at a set speed instead.
 *
 * Scroll nudges the view (and, following the voice, re-anchors the tracker
 * at what is now a third of the way down); click pauses or resumes;
 * double-click goes back to the file list.
 */
export class MuseReaderLayer implements Layer {
  private layout: MuseLayout | null = null;
  private layoutKey = "";
  private tracker: ScriptTracker | null = null;
  private mode = loadMode();
  private speed = loadSpeed();
  /** Following the voice: listening. Auto-scroll: scrolling. */
  private running = false;
  private attached = false;
  private scrollY = 0;
  private targetY = 0;
  /** Word to put at the anchor row on the next paint (open, or a relayout). */
  private restorePosition: number | null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private lastTickMs = 0;
  private viewHeight = 288;
  private stack: LayerStack | null = null;
  private status = "";
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;

  constructor(
    private readonly doc: MuseDocument,
    readonly title: string,
    private settings: MuseSettings,
    private readonly hooks: MuseReaderHooks,
    initialPosition = 0,
  ) {
    this.restorePosition = initialPosition;
  }

  /** Start listening (when following the voice). Called once the layer is on its stack. */
  attach(): void {
    this.attached = true;
    this.unsubscribeStatus = voiceControlBridge.onStatus((state) => {
      this.status = state.status;
      this.hooks.requestRender();
    });
    if (this.mode === "voice") this.startListening();
  }

  onRemoved(): void {
    this.hooks.savePosition(this.resumePosition());
    this.stopListening();
    this.attached = false;
    this.running = false;
    this.syncTicker();
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
  }

  buildMenuItems(): MenuItem[] {
    const items: MenuItem[] = [
      {
        label:
          this.mode === "voice" ? (this.running ? "Stop listening" : "Listen") : this.running ? "Pause" : "Play",
        onSelect: (ctx) => {
          ctx.stack.pop();
          this.toggleRunning();
        },
      },
      {
        label: this.mode === "voice" ? "Mode: follow my voice" : "Mode: auto-scroll",
        onSelect: (ctx) => {
          ctx.stack.pop();
          this.toggleMode();
        },
      },
    ];
    if (this.mode === "auto") {
      items.push(
        this.cycleItem("Speed", SPEEDS, () => this.speed as (typeof SPEEDS)[number], (speed) => {
          this.speed = speed;
          setStringSetting(SPEED_KEY, String(speed));
        }, (speed) => SPEED_LABELS[SPEEDS.indexOf(speed)] ?? String(speed)),
      );
    }
    if (this.doc.hasText) {
      items.push(this.cycleItem("Text size", TEXT_SIZES, () => this.settings.text, (text) => this.changeSettings({ text })));
    }
    if (this.doc.hasMusic) {
      items.push(
        this.cycleItem("Lyrics", SIZES, () => this.settings.lyrics, (lyrics) => this.changeSettings({ lyrics })),
        this.cycleItem("Notes", SIZES, () => this.settings.notes, (notes) => this.changeSettings({ notes })),
        this.cycleItem("Staves", STAVES, () => this.settings.staves, (staves) => this.changeSettings({ staves }), (n) => `${n} per screen`),
        this.cycleItem("Clef", CLEFS, () => this.settings.clef, (clef) => this.changeSettings({ clef }), (c) => CLEF_LABELS[c]),
      );
    }
    items.push({
      label: "Back to the top",
      onSelect: (ctx) => {
        ctx.stack.pop();
        this.tracker?.anchor(0);
        this.scrollY = this.targetY = 0;
        if (this.mode === "auto") this.running = false;
        this.syncTicker();
      },
    });
    return items;
  }

  /**
   * A menu row that steps through `values` and stays open, relabelling
   * itself, so you can watch the page change behind the menu.
   */
  private cycleItem<T extends string | number>(
    name: string,
    values: readonly T[],
    get: () => T,
    set: (value: T) => void,
    show: (value: T) => string = String,
  ): MenuItem {
    const item: MenuItem = {
      label: `${name}: ${show(get())}`,
      onSelect: () => {
        const current = get();
        const index = values.indexOf(current);
        // A size from a hand-edited file may be off the list: step to the next larger one.
        const next =
          index >= 0
            ? values[(index + 1) % values.length]!
            : (values.find((value) => typeof value === "number" && value > (current as number)) ?? values[0]!);
        set(next);
        item.label = `${name}: ${show(get())}`;
        this.hooks.requestRender();
      },
    };
    return item;
  }

  private changeSettings(change: Partial<MuseSettings>): void {
    this.restorePosition = this.position();
    this.settings = { ...this.settings, ...change };
    this.hooks.saveSettings(this.settings);
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    this.stack = ctx.stack;
    this.viewHeight = height;
    const layout = this.ensureLayout(width - 2 * MARGIN_X);
    if (this.restorePosition !== null) {
      const position = this.restorePosition;
      this.restorePosition = null;
      this.tracker?.anchor(position);
      this.scrollY = this.targetY = this.scrollFor(position);
    }

    const frame = new GrayImage(width, height, 0);
    const top = Math.round(this.scrollY);
    // Only the rows in view touch the wire; each is a cached image draw.
    for (let i = this.firstRowBelow(top); i < layout.rows.length; i++) {
      const row = layout.rows[i]!;
      if (row.y >= top + height) break;
      frame.drawImage(row.image, MARGIN_X + row.x, row.y - top);
    }

    const position = this.tracker?.position ?? 0;
    if (this.mode === "voice" && position < layout.anchors.length) {
      const anchor = layout.anchors[position]!;
      const y = layout.rows[anchor.row]!.y + anchor.underlineY - top;
      if (y >= 0 && y < height - 1) {
        frame.fillRect(MARGIN_X + anchor.x, y, Math.max(4, anchor.width), 2, this.running ? 255 : 90);
      }
    }

    const max = this.maxScroll();
    if (max > 0) {
      const barHeight = Math.max(6, Math.round((height * height) / (layout.height + height)));
      const barY = Math.round((height - barHeight) * (this.scrollY / max));
      frame.fillRect(width - 3, barY, 2, barHeight, this.running ? 200 : 85);
    }

    const label = this.statusLabel();
    if (label) {
      const font = getDefaultSmallFont();
      frame.drawText(font, width - MARGIN_X - font.measureText(label), height - font.lineHeight - 2, label, 150);
    }
    return frame;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-down":
        this.scrollBy(this.manualStep());
        return;
      case "scroll-up":
        this.scrollBy(-this.manualStep());
        return;
      case "click":
        this.toggleRunning();
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  private ensureLayout(width: number): MuseLayout {
    const key = `${width}:${museFontKey()}:${JSON.stringify(this.settings)}`;
    if (this.layout && this.layoutKey === key) return this.layout;
    if (this.layout && this.restorePosition === null) this.restorePosition = this.position();
    this.layout = layoutDocument(this.doc, this.settings, width, museFont);
    this.layoutKey = key;
    // The words come from the content alone, so a relayout keeps the same list.
    if (!this.tracker || this.tracker.wordCount !== this.layout.words.length) {
      const position = this.tracker?.position ?? 0;
      this.tracker = new ScriptTracker(this.layout.words);
      this.tracker.anchor(position);
    }
    return this.layout;
  }

  private statusLabel(): string {
    if (!this.running) return "Paused";
    if (this.mode === "voice" && this.status && !this.status.startsWith("Listening")) return this.status;
    return "";
  }

  private anchorOffset(): number {
    return Math.round(this.viewHeight / 3);
  }

  private manualStep(): number {
    return Math.max(16, Math.round(this.viewHeight / 6));
  }

  /** Far enough that the last row can reach the anchor line. */
  private maxScroll(): number {
    return Math.max(0, (this.layout?.height ?? 0) - this.anchorOffset());
  }

  private clampScroll(y: number): number {
    return clamp(y, 0, this.maxScroll());
  }

  /** Scroll that puts `position`'s row on the anchor line. */
  private scrollFor(position: number): number {
    const layout = this.layout;
    if (!layout || !layout.anchors.length) return 0;
    const anchor = layout.anchors[Math.min(position, layout.anchors.length - 1)]!;
    return this.clampScroll(layout.rows[anchor.row]!.y - this.anchorOffset());
  }

  private firstRowBelow(y: number): number {
    const rows = this.layout?.rows ?? [];
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid]!.y + rows[mid]!.height <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The first word drawn on or below `y`, or the word count when there is none. */
  private firstWordFrom(y: number): number {
    const layout = this.layout;
    if (!layout) return 0;
    let lo = 0;
    let hi = layout.anchors.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (layout.rows[layout.anchors[mid]!.row]!.y < y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The word the reader is at: the tracker's, or (auto-scrolling) the first one at the anchor line. */
  private position(): number {
    if (this.mode === "voice") return this.tracker?.position ?? 0;
    return this.firstWordFrom(Math.round(this.scrollY) + this.anchorOffset());
  }

  /** Where to resume next time: a document read to the end starts over. */
  private resumePosition(): number {
    const position = this.position();
    return position >= (this.layout?.words.length ?? 0) ? 0 : position;
  }

  private scrollBy(delta: number): void {
    this.scrollY = this.targetY = this.clampScroll(this.scrollY + delta);
    if (this.mode === "voice") {
      this.tracker?.anchor(this.firstWordFrom(Math.round(this.scrollY) + this.anchorOffset()));
    } else {
      this.running = false;
    }
    this.syncTicker();
    this.hooks.requestRender();
  }

  private toggleRunning(): void {
    if (this.mode === "voice") {
      if (this.running) {
        this.stopListening();
        this.hooks.savePosition(this.resumePosition());
      } else {
        this.startListening();
      }
    } else {
      if (!this.running && this.scrollY >= this.maxScroll() - 0.5) this.scrollY = this.targetY = 0;
      this.running = !this.running;
    }
    this.syncTicker();
    this.hooks.requestRender();
  }

  private toggleMode(): void {
    const position = this.position();
    if (this.mode === "voice") {
      this.stopListening();
      this.mode = "auto";
    } else {
      this.mode = "voice";
      this.tracker?.anchor(position);
      this.startListening();
    }
    setStringSetting(MODE_KEY, this.mode);
    this.syncTicker();
    this.hooks.requestRender();
  }

  private startListening(): void {
    this.running = true;
    this.unsubscribeTranscript ??= voiceControlBridge.onTranscript((event) => this.onTranscript(event));
    this.hooks.startCapture();
  }

  private stopListening(): void {
    if (this.mode === "voice") this.running = false;
    if (!this.unsubscribeTranscript) return;
    this.unsubscribeTranscript();
    this.unsubscribeTranscript = null;
    this.hooks.stopCapture();
  }

  private onTranscript(event: VoiceTranscriptEvent): void {
    if (this.mode !== "voice" || !this.running || !this.tracker) return;
    if (!this.tracker.feed(event.text)) return;
    this.targetY = this.scrollFor(this.tracker.position);
    this.syncTicker();
    this.hooks.requestRender();
  }

  /** Run the animation tick while auto-scrolling or gliding toward a voice-follow target. */
  private syncTicker(): void {
    const moving = (this.mode === "auto" && this.running) || Math.abs(this.targetY - this.scrollY) > 0.5;
    const want = this.attached && moving;
    if (!want && this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    } else if (want && this.ticker === null) {
      this.lastTickMs = Date.now();
      this.ticker = setInterval(() => this.tick(), RENDER_TICK_MS);
    }
  }

  private tick(): void {
    const now = Date.now();
    const dt = Math.min(0.25, (now - this.lastTickMs) / 1000);
    this.lastTickMs = now;
    if (this.mode === "auto" && this.running) {
      if (this.stack && !this.stack.isFocused()) {
        this.running = false; // don't scroll on unseen
      } else {
        this.scrollY = this.targetY = Math.min(this.maxScroll(), this.scrollY + this.speed * dt);
        if (this.scrollY >= this.maxScroll()) this.running = false;
      }
    } else {
      this.scrollY += (this.targetY - this.scrollY) * (1 - Math.exp(-dt / FOLLOW_TAU_S));
      if (Math.abs(this.targetY - this.scrollY) <= 0.5) this.scrollY = this.targetY;
    }
    this.syncTicker();
    this.hooks.requestRender();
  }
}
