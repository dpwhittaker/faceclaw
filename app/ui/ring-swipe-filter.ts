import { type InputEvent } from "./gestures";

/**
 * One swipe on the R1 can arrive as two to four swipe reports 60-130 ms apart,
 * and each extra report would move one more step. Every touch of the ring
 * sends a ring-press first, so a report after a fresh touch is a new swipe
 * however fast the wearer swipes; repeats have none. A ring swipe without a
 * ring-press since the last report (firmware that doesn't forward ring-press)
 * counts as new only once the previous report is this old.
 */
const SWIPE_REPEAT_MS = 250;

/**
 * Tells a new ring swipe from the R1 repeating the last one, for layers where
 * every swipe is one deliberate step (the ring keyboard, the Bible picker).
 * Feed it every event; it needs the ring-press events (the layer must accept
 * them) to tell fast swipes apart.
 */
export class RingSwipeFilter {
  /** A ring-press arrived since the last ring swipe report. */
  private touchedSinceSwipe = false;
  private lastRingSwipeAtMs = -Infinity;

  /**
   * False for an event to drop: a repeated swipe report, or a ring-press
   * (which only feeds the filter). Everything else passes.
   */
  accept(event: InputEvent): boolean {
    if (event.type === "ring-press") {
      this.touchedSinceSwipe = true;
      return false;
    }
    if (event.type !== "scroll-up" && event.type !== "scroll-down") return true;
    // Temple swipes don't repeat and never send ring-press.
    if (event.source === "left-arm" || event.source === "right-arm") return true;
    const fresh = this.touchedSinceSwipe || event.timestampMs - this.lastRingSwipeAtMs >= SWIPE_REPEAT_MS;
    this.touchedSinceSwipe = false;
    this.lastRingSwipeAtMs = event.timestampMs;
    return fresh;
  }
}
