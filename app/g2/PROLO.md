# Prolo Ring input source (scaffold)

Uses a Prolo Ring (or any Bluetooth HID mouse/trackpad) as a 2D input surface
for the glasses, as a peer of the Wear OS watch remote. **Status: scaffold —
not yet built or tested on hardware.** The gesture-mapping and bridge are
complete; the Android pointer-capture and the two wiring points below need
finishing.

## Files

| File | Role |
|---|---|
| `app/g2/prolo-remote.ts` | Gesture logic: raw HID deltas/clicks/scroll → the same `WearRemoteInputKind` the watch injects. Complete + tunable. |
| `app/native/prolo-bridge.ts` | TS↔Java glue (mirrors `wear-bridge.ts`); no-op until the native source is wired. |
| `App_Resources/…/FaceclawProloInput.java` | Android pointer-capture source (scaffold; needs MainActivity wiring). |
| `App_Resources/…/FaceclawProloListener.java` | Callback interface Java→TS. |

## Design

The ring pairs as a **standard Bluetooth HID device** (no vendor SDK needed).
We capture its raw pointer input via Android **pointer capture** and feed the
**same synthetic-ring path the watch uses** — `injectSyntheticRingInput(kind,
"watch")`. Source `"watch"` is deliberate: `swipe-*` events are typed to that
source in `app/ui/gestures.ts`, so the Prolo inherits the watch's spatial scheme
(up/down = scroll, right = into, left = back, tap = select) with no UI changes.

Mapping: trackpad flick → `swipe-{up,down,left,right}`; tap → `click`; two taps →
`double-click`; tap-and-hold → `long-press` (or `short-then-long-press` after a
recent tap); HID scroll → `scroll-{up,down}`.

## Wiring to finish

**1. Dashboard controller** (`app/g2/dashboard-controller.ts`), next to `this.wearRemote = new WearRemote({…})`:

```ts
import { ProloRemote } from "./prolo-remote";
import { proloRemoteEnabledSetting } from "../ui/dashboard-settings";
// …
private proloRemote: ProloRemote | null = null;
// …in the same place the WearRemote is constructed:
this.proloRemote = new ProloRemote({
  injectInput: (kind) => this.injectSyntheticRingInput(kind, "watch"),
  isEnabled: () => proloRemoteEnabledSetting.get(),
});
if (proloRemoteEnabledSetting.get()) this.proloRemote.start();
// react to the setting (mirror how other toggles are observed), and on teardown call this.proloRemote?.stop();
```

**2. `MainActivity`** — give the native source the activity + focus events:

```java
@Override protected void onResume() {
  super.onResume();
  FaceclawProloInput.getInstance(getApplicationContext()).setActivity(this);
}
@Override protected void onPause() {
  FaceclawProloInput.getInstance(getApplicationContext()).setActivity(null);
  super.onPause();
}
@Override public void onWindowFocusChanged(boolean hasFocus) {
  super.onWindowFocusChanged(hasFocus);
  FaceclawProloInput.getInstance(getApplicationContext()).onWindowFocusChanged(hasFocus);
}
```

**3. Setting** — add a `ConfigSettingBool proloRemoteEnabledSetting` in
`app/ui/dashboard-settings.ts` (copy `watchRemoteEnabledSetting`) and a row in
the settings UI.

## Tuning

The thresholds in `prolo-remote.ts` (`FLICK_THRESHOLD`, `AXIS_DOMINANCE`,
`TAP_MAX_*`, `LONG_PRESS_MS`, `SCROLL_STEP`) are guesses — HID delta scale
depends on the ring's DPI and Android's pointer-speed setting. Calibrate on
hardware; log `ProloPointerEvent`s first to see the real delta magnitudes.

## Known limitation: screen-off / glasses-only

Android delivers HID pointer input only to a **focused window**, so this path
works while **faceclaw is foreground with the phone screen on**. For true
screen-off, glasses-only field use, pointer capture won't fire. Options, roughly
in order of effort:

1. **Accept foreground-only** for v1 (fine while you're actively iterating with
   the phone awake).
2. **Prolo Studio app → key/media macros:** map ring gestures to keys the phone
   can deliver to a background app via a `MediaSession` or a foreground service,
   and have faceclaw translate those to `InputEvent`s. Limited vocabulary, but
   works screen-off.
3. **AccessibilityService** reading global input — most capable, most invasive
   (accessibility permission), and screen-off input delivery is still restricted.

The watch avoids this because it uses the Wearable Data Layer (a background
service), not HID/window focus — a Prolo equivalent would be option 2 or 3.
