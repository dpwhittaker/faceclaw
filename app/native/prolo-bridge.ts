/**
 * TS wrapper for the Java FaceclawProloInput: raw HID pointer input from a
 * paired Prolo Ring (or any Bluetooth HID mouse/trackpad), delivered via
 * Android pointer capture. The semantic mapping (deltas → gestures) lives in
 * app/g2/prolo-remote.ts; this file only crosses the Java boundary.
 *
 * Every call is a no-op when not on Android or when the native input source
 * isn't wired/available, so callers never have to branch.
 */
import { Utils } from "@nativescript/core";

declare const com: any;
declare const global: any;

export type ProloPointerEvent = {
  /** "move" (dx,dy relative), "down"/"up" (button), or "scroll" (wheel). */
  type: "move" | "down" | "up" | "scroll";
  dx: number;
  dy: number;
  /** Android MotionEvent button constant for down/up (BUTTON_PRIMARY = 1). */
  button: number;
  /** Signed wheel delta for "scroll" (wheel-up is negative). */
  scroll: number;
};

type PointerListener = (event: ProloPointerEvent) => void;

class ProloBridge {
  private java: any | null | undefined = undefined;
  private retainedListenerProxy: any = null;
  private captureEnabled = false;
  private readonly listeners = new Set<PointerListener>();

  private getJava(): any | null {
    if (this.java !== undefined) return this.java;
    if (!global.isAndroid) {
      this.java = null;
      return null;
    }
    try {
      const context = Utils.android.getApplicationContext();
      // FaceclawProloInput is a scaffold; guard so a build without it is a no-op.
      const cls = com.faceclaw.app && com.faceclaw.app.FaceclawProloInput;
      this.java = cls && context ? cls.getInstance(context) : null;
    } catch (error) {
      console.warn("prolo bridge unavailable", error);
      this.java = null;
    }
    return this.java;
  }

  /** Whether the native pointer-capture source exists on this build/device. */
  isAvailable(): boolean {
    return this.getJava() !== null;
  }

  private ensureListener(): void {
    if (this.retainedListenerProxy) return;
    const java = this.getJava();
    if (!java) return;
    // Java calls onPointer(type, dx, dy, button, scroll) on the main isolate.
    this.retainedListenerProxy = new com.faceclaw.app.FaceclawProloListener({
      onPointer: (type: string, dx: number, dy: number, button: number, scroll: number) => {
        const event: ProloPointerEvent = {
          type: type as ProloPointerEvent["type"],
          dx: Number(dx) || 0,
          dy: Number(dy) || 0,
          button: Number(button) || 0,
          scroll: Number(scroll) || 0,
        };
        for (const l of this.listeners) {
          try {
            l(event);
          } catch (err) {
            console.error(`prolo listener failed: ${err}`);
          }
        }
      },
    });
    java.setListener(this.retainedListenerProxy);
  }

  /** Subscribe to pointer events. Returns an unsubscribe fn. */
  onPointer(listener: PointerListener): () => void {
    this.listeners.add(listener);
    this.ensureListener();
    return () => this.listeners.delete(listener);
  }

  /**
   * Request/release Android pointer capture on the foreground activity so HID
   * mouse deltas come to us instead of moving a system cursor. No-op if the
   * native source is missing.
   */
  setCaptureEnabled(enabled: boolean): void {
    if (this.captureEnabled === enabled) return;
    const java = this.getJava();
    if (!java) return;
    this.captureEnabled = enabled;
    try {
      java.setCaptureEnabled(enabled);
    } catch (error) {
      console.warn("prolo setCaptureEnabled failed", error);
    }
  }
}

export const proloBridge = new ProloBridge();
