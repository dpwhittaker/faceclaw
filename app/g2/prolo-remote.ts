/**
 * Prolo Ring as a 2D input surface for the glasses — a peer of the Wear OS
 * watch remote (app/g2/wear-remote.ts).
 *
 * The Prolo Ring pairs as a standard Bluetooth HID device (trackpad + 6-axis
 * IMU, exposed as mouse cursor / scroll / clicks). We capture its raw relative
 * pointer input on the phone (app/native/prolo-bridge.ts → Android pointer
 * capture) and translate it into the SAME synthetic-ring input the watch feeds:
 * host.injectInput(kind) → dashboard-controller.injectSyntheticRingInput(kind,
 * "watch"). Reusing source "watch" is deliberate — swipe-* events are typed to
 * that source in app/ui/gestures.ts, so the Prolo gets the watch's spatial
 * scheme (up/down scroll, right = into, left = back, tap = select) for free.
 *
 * Mapping (calibrate the thresholds on hardware — HID delta scale depends on
 * the ring's DPI and Android's pointer-speed setting):
 *   trackpad flick   → swipe-up / -down / -left / -right (dominant axis)
 *   trackpad tap     → click ; two quick taps → double-click
 *   tap-and-hold     → long-press (or short-then-long-press after a recent tap)
 *   HID scroll       → scroll-up / scroll-down
 *
 * SCOPE / KNOWN LIMIT: Android delivers HID pointer input only to a focused
 * window, so this works while faceclaw is foreground with the phone screen on.
 * Screen-off, glasses-only use needs a different path (see app/g2/PROLO.md).
 */
import { type WearRemoteInputKind } from "./wear-remote";
import { proloBridge, type ProloPointerEvent } from "../native/prolo-bridge";

export type ProloRemoteHost = {
  /** Same injection the watch uses: controller.injectSyntheticRingInput(kind, "watch"). */
  injectInput: (kind: WearRemoteInputKind) => Promise<void> | void;
  /** User setting gate (Settings → … → Prolo Ring). */
  isEnabled: () => boolean;
};

// --- Tunables (px of raw HID delta; tune on-device) --------------------------
const FLICK_THRESHOLD = 60; // net travel in the dominant axis to fire a flick
const AXIS_DOMINANCE = 1.3; // dominant axis must beat the other by this factor
const IDLE_RESET_MS = 180; // no movement this long ends the current flick gesture
const TAP_MAX_MS = 250; // button down→up within this (and little movement) = a tap
const TAP_MAX_MOVE = 20; // total travel allowed during a tap
const DOUBLE_TAP_MS = 320; // two taps inside this window = double-click
const LONG_PRESS_MS = 500; // button held this long = long-press
const SCROLL_STEP = 40; // HID scroll travel per emitted scroll step

const PRIMARY_BUTTON = 1; // Android MotionEvent.BUTTON_PRIMARY

export class ProloRemote {
  private started = false;
  private unsubscribe: (() => void) | null = null;

  // Flick accumulation.
  private accumX = 0;
  private accumY = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  // Button / tap state.
  private buttonDownAt = 0;
  private buttonTravel = 0;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressFired = false;
  private lastTapAt = 0;

  // Scroll accumulation.
  private scrollAccum = 0;

  constructor(private readonly host: ProloRemoteHost) {}

  /** Subscribe to pointer input and enable capture. Safe to call repeatedly. */
  start(): void {
    if (this.started) return;
    if (!proloBridge.isAvailable()) return; // no ring / not Android
    this.started = true;
    this.unsubscribe = proloBridge.onPointer((e) => this.onPointer(e));
    proloBridge.setCaptureEnabled(true);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    proloBridge.setCaptureEnabled(false);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearIdle();
    this.clearLongPress();
    this.reset();
  }

  private reset(): void {
    this.accumX = 0;
    this.accumY = 0;
    this.scrollAccum = 0;
  }

  private inject(kind: WearRemoteInputKind): void {
    try {
      const r = this.host.injectInput(kind);
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch((err) => console.error(`prolo injectInput failed: ${err}`));
      }
    } catch (err) {
      console.error(`prolo injectInput threw: ${err}`);
    }
  }

  private onPointer(e: ProloPointerEvent): void {
    if (!this.host.isEnabled()) return;
    switch (e.type) {
      case "move":
        this.onMove(e.dx, e.dy);
        break;
      case "down":
        if (e.button === PRIMARY_BUTTON) this.onButtonDown();
        break;
      case "up":
        if (e.button === PRIMARY_BUTTON) this.onButtonUp();
        break;
      case "scroll":
        this.onScroll(e.scroll);
        break;
    }
  }

  // --- Movement → flicks (and travel budget for tap vs drag) -----------------
  private onMove(dx: number, dy: number): void {
    this.buttonTravel += Math.abs(dx) + Math.abs(dy);
    this.accumX += dx;
    this.accumY += dy;
    this.armIdle();

    const ax = Math.abs(this.accumX);
    const ay = Math.abs(this.accumY);
    if (ax >= FLICK_THRESHOLD && ax >= ay * AXIS_DOMINANCE) {
      this.inject(this.accumX > 0 ? "swipe-right" : "swipe-left");
      this.reset();
    } else if (ay >= FLICK_THRESHOLD && ay >= ax * AXIS_DOMINANCE) {
      // Android y grows downward: +y = down.
      this.inject(this.accumY > 0 ? "swipe-down" : "swipe-up");
      this.reset();
    }
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.reset(), IDLE_RESET_MS);
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // --- Buttons → tap / double-tap / long-press -------------------------------
  private onButtonDown(): void {
    this.buttonDownAt = Date.now();
    this.buttonTravel = 0;
    this.longPressFired = false;
    this.clearLongPress();
    this.longPressTimer = setTimeout(() => {
      if (this.buttonTravel > TAP_MAX_MOVE) return; // became a drag; not a press
      this.longPressFired = true;
      // A tap immediately before the hold is the ring/watch "tap-then-hold".
      const recentTap = Date.now() - this.lastTapAt <= DOUBLE_TAP_MS;
      this.inject(recentTap ? "short-then-long-press" : "long-press");
      this.lastTapAt = 0;
    }, LONG_PRESS_MS);
  }

  private onButtonUp(): void {
    this.clearLongPress();
    if (this.longPressFired) {
      this.inject("long-press-release");
      this.longPressFired = false;
      return;
    }
    const heldMs = Date.now() - this.buttonDownAt;
    if (heldMs <= TAP_MAX_MS && this.buttonTravel <= TAP_MAX_MOVE) {
      if (Date.now() - this.lastTapAt <= DOUBLE_TAP_MS) {
        this.inject("double-click");
        this.lastTapAt = 0;
      } else {
        this.inject("click");
        this.lastTapAt = Date.now();
      }
    }
  }

  private clearLongPress(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  // --- HID scroll (Modstrip / air wheel) → scroll steps ----------------------
  private onScroll(scroll: number): void {
    this.scrollAccum += scroll;
    while (Math.abs(this.scrollAccum) >= SCROLL_STEP) {
      const up = this.scrollAccum < 0; // wheel-up is negative on Android
      this.inject(up ? "scroll-up" : "scroll-down");
      this.scrollAccum += up ? SCROLL_STEP : -SCROLL_STEP;
    }
  }
}
