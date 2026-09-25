package com.faceclaw.app;

/**
 * Callback the TS side (app/native/prolo-bridge.ts) implements to receive raw
 * HID pointer input from a paired Prolo Ring via Android pointer capture.
 *
 * Called on the main (JS) thread.
 *   type:   "move" | "down" | "up" | "scroll"
 *   dx,dy:  relative movement (captured-pointer deltas) for "move"
 *   button: MotionEvent button constant for "down"/"up" (BUTTON_PRIMARY = 1)
 *   scroll: signed vertical wheel delta for "scroll" (wheel-up is negative)
 */
public interface FaceclawProloListener {
    void onPointer(String type, float dx, float dy, int button, float scroll);
}
