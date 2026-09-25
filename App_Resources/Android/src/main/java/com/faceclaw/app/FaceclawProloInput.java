package com.faceclaw.app;

import android.app.Activity;
import android.content.Context;
import android.os.Build;
import android.view.MotionEvent;
import android.view.View;

/**
 * SCAFFOLD — Prolo Ring (or any Bluetooth HID mouse/trackpad) as a captured
 * pointer source. Turns raw HID deltas/clicks/scroll into FaceclawProloListener
 * callbacks; app/g2/prolo-remote.ts maps those to synthetic-ring gestures.
 *
 * How it works: Android delivers HID pointer input to a FOCUSED window. We
 * request pointer capture (API 26+) on the foreground activity's content view
 * so the ring's movement comes to us as relative deltas instead of driving a
 * system cursor, then forward each MotionEvent to the TS listener.
 *
 * INTEGRATION TODO (why this is a scaffold):
 *   1. MainActivity must hand us the Activity so we can reach a focusable view:
 *        FaceclawProloInput.getInstance(getApplicationContext()).setActivity(this);
 *      (call in onResume; and setActivity(null) in onPause).
 *   2. MainActivity should re-request capture on window-focus regain
 *      (onWindowFocusChanged) — capture is dropped whenever the window loses
 *      focus, so it must be re-armed.
 *   3. KNOWN LIMIT: pointer capture needs a focused window, i.e. faceclaw
 *      foreground with the screen on. Screen-off / glasses-only use needs a
 *      different transport (see app/g2/PROLO.md).
 *
 * Everything here is guarded so a build that hasn't done the wiring is inert
 * (isAvailable() stays false on the TS side until setActivity() is called).
 */
public final class FaceclawProloInput {
    private static FaceclawProloInput instance;

    private final Context appContext;
    private FaceclawProloListener listener;
    private Activity activity;
    private View captureView;
    private boolean captureRequested;

    private FaceclawProloInput(Context context) {
        this.appContext = context.getApplicationContext();
    }

    public static synchronized FaceclawProloInput getInstance(Context context) {
        if (instance == null) instance = new FaceclawProloInput(context);
        return instance;
    }

    public void setListener(FaceclawProloListener listener) {
        this.listener = listener;
    }

    /** MainActivity calls this from onResume(this) / onPause(null). */
    public void setActivity(Activity activity) {
        this.activity = activity;
        if (activity == null) {
            releaseCapture();
            this.captureView = null;
        } else if (captureRequested) {
            armCapture();
        }
    }

    /** Called by TS (prolo-bridge) to start/stop consuming the ring. */
    public void setCaptureEnabled(boolean enabled) {
        this.captureRequested = enabled;
        if (enabled) armCapture();
        else releaseCapture();
    }

    /** MainActivity.onWindowFocusChanged(hasFocus) should call this. */
    public void onWindowFocusChanged(boolean hasFocus) {
        if (hasFocus && captureRequested) armCapture();
    }

    private void armCapture() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return; // requestPointerCapture: API 26+
        if (activity == null) return;
        View content = activity.findViewById(android.R.id.content);
        if (content == null) return;
        this.captureView = content;
        content.setFocusable(true);
        content.setFocusableInTouchMode(true);
        content.requestFocus();
        content.setOnCapturedPointerListener((view, event) -> handleCaptured(event));
        // Must run once the view is attached and the window is focused; a
        // post() lets a freshly-resumed activity settle first.
        content.post(content::requestPointerCapture);
    }

    private void releaseCapture() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (captureView != null) {
            try {
                captureView.releasePointerCapture();
                captureView.setOnCapturedPointerListener(null);
            } catch (Throwable ignored) { /* view gone */ }
        }
    }

    private boolean handleCaptured(MotionEvent event) {
        FaceclawProloListener l = this.listener;
        if (l == null) return false;
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_MOVE:
            case MotionEvent.ACTION_HOVER_MOVE:
                // In captured mode getX()/getY() are relative deltas.
                l.onPointer("move", event.getX(), event.getY(), 0, 0f);
                return true;
            case MotionEvent.ACTION_BUTTON_PRESS:
                l.onPointer("down", 0f, 0f, event.getActionButton(), 0f);
                return true;
            case MotionEvent.ACTION_BUTTON_RELEASE:
                l.onPointer("up", 0f, 0f, event.getActionButton(), 0f);
                return true;
            case MotionEvent.ACTION_SCROLL:
                l.onPointer("scroll", 0f, 0f, 0, event.getAxisValue(MotionEvent.AXIS_VSCROLL));
                return true;
            default:
                return false;
        }
    }
}
