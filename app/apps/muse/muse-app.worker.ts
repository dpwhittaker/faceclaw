/**
 * Muse worker — smooth-scrolling sheet music.
 *
 * The whole hymn is engraved once at load into per-system band images
 * (core/score-image.ts). Each frame paints the bands that fall in the viewport
 * with GrayImage.drawImage, i.e. as deferred image draws: flattenPlanesWithDraws
 * hands them to the texture-cache wire path (glyph-wire.ts), so a band uploads
 * to the glasses once and every later frame just moves it with a small
 * placement record. That is what lets the entire score scroll smoothly on CFW,
 * instead of the EvenHub original's re-upload-per-container half-screen grid.
 *
 * Controls: scroll-up/down nudge the score (ring scroll, watch crown, or the
 * up/down fallback of a watch swipe); click toggles auto-scroll; tap-then-long
 * opens the window menu (play/pause, speed, jump to top, close).
 */
import "@nativescript/core/globals";
import { GrayImage } from "../../graphics/image";
import { flattenPlanesWithDraws, planesFingerprint, singlePlane, type Plane } from "../../graphics/plane";
import { prepareFrameDraws } from "../../graphics/glyph-wire";
import * as frameTimings from "../../native/frame-timings";
import { getActiveDisplay } from "../../native/active-display";
import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { directionalFallback, type InputEvent } from "../../ui/gestures";
import { type MenuItem } from "../../ui/menu";
import { WindowMenu } from "../../ui/window-menu";
import type { WorkerAppMessage, WorkerAppReply } from "../../ui/shell/worker-window";
import { engraveToBands, type ScoreBands } from "./core/score-image";
import { SAMPLE_TITLE } from "./core/sample-score";

declare const global: any;

/** Engraved once; the band images are immutable and shared by every window. */
const SCORE: ScoreBands = engraveToBands();

const SPEED_KEY = "muse.speedPxPerSec";
const SPEEDS = [16, 28, 44, 70] as const; // slow → fast, px/sec
const DEFAULT_SPEED = 28;
/** Manual nudge per scroll event, ~ half a system. */
const MANUAL_STEP = Math.max(12, Math.round(SCORE.bandHeight * 0.6));
const RENDER_TICK_MS = 30;

let screenOn = true;

type MuseWindow = {
  windowId: string;
  surfaceId: string;
  title: string;
  viewportWidth: number;
  viewportHeight: number;
  foreground: boolean;
  focused: boolean;
  menu: WindowMenu | null;
  /** Top of the viewport within the score, in px. */
  scrollY: number;
  auto: boolean;
  speed: number;
  tickTimer: ReturnType<typeof setInterval> | null;
  lastTickAtMs: number;
  lastSubmittedFingerprint: string;
};

const windows = new Map<string, MuseWindow>();

function post(message: WorkerAppReply): void {
  global.postMessage(message);
}

post({ type: "worker-ready" });

function loadSpeed(): number {
  try {
    const parsed = parseInt(getStringSetting(SPEED_KEY, String(DEFAULT_SPEED)), 10);
    return SPEEDS.includes(parsed as (typeof SPEEDS)[number]) ? parsed : DEFAULT_SPEED;
  } catch {
    return DEFAULT_SPEED;
  }
}

function maxScroll(window: MuseWindow): number {
  return Math.max(0, SCORE.totalHeight - window.viewportHeight);
}

function clampScroll(window: MuseWindow): void {
  const max = maxScroll(window);
  if (window.scrollY < 0) window.scrollY = 0;
  else if (window.scrollY > max) window.scrollY = max;
}

global.onmessage = (event: { data: WorkerAppMessage }) => {
  const message = event.data;
  switch (message.type) {
    case "open-window": {
      const window: MuseWindow = {
        windowId: message.windowId,
        surfaceId: message.surfaceId,
        title: message.title,
        viewportWidth: message.viewport.width,
        viewportHeight: message.viewport.height,
        foreground: false,
        focused: false,
        menu: null,
        scrollY: 0,
        auto: false,
        speed: loadSpeed(),
        tickTimer: null,
        lastTickAtMs: 0,
        lastSubmittedFingerprint: "",
      };
      windows.set(message.windowId, window);
      break;
    }
    case "resize-window": {
      const window = windows.get(message.windowId);
      if (!window) break;
      window.viewportWidth = message.viewport.width;
      window.viewportHeight = message.viewport.height;
      window.menu?.resize({ width: window.viewportWidth, height: window.viewportHeight });
      clampScroll(window);
      if (window.foreground) renderAndSubmit(window, 0);
      break;
    }
    case "close-window": {
      const window = windows.get(message.windowId);
      if (window?.tickTimer) clearInterval(window.tickTimer);
      windows.delete(message.windowId);
      break;
    }
    case "input": {
      const window = windows.get(message.windowId);
      if (!window) {
        frameTimings.finishFrame(message.frameId, "discarded: unknown muse window");
        break;
      }
      window.focused = message.focused;
      inferForeground(window, message.focused);
      handleInput(window, message.event as InputEvent, message.frameId);
      break;
    }
    case "render": {
      const window = windows.get(message.windowId);
      if (!window) break;
      window.focused = message.focused;
      inferForeground(window, message.focused);
      renderAndSubmit(window, 0);
      break;
    }
    case "foreground": {
      const window = windows.get(message.windowId);
      if (!window) break;
      window.foreground = message.foreground;
      window.focused = message.focused;
      if (!window.foreground) window.auto = false; // don't scroll unseen
      syncTickTimer(window);
      if (window.foreground) renderAndSubmit(window, 0);
      break;
    }
    case "input-focus": {
      const window = windows.get(message.windowId);
      if (!window) break;
      if (!message.focused) {
        window.auto = false;
        syncTickTimer(window);
        if (window.foreground) renderAndSubmit(window, 0);
      }
      break;
    }
    case "screen":
      screenOn = message.on;
      for (const window of windows.values()) {
        if (!screenOn) window.auto = false;
        syncTickTimer(window);
      }
      break;
  }
};

function inferForeground(window: MuseWindow, focused: boolean): void {
  if (!focused || window.foreground) return;
  window.foreground = true;
  syncTickTimer(window);
}

function syncTickTimer(window: MuseWindow): void {
  const shouldRun = window.foreground && screenOn && window.auto && window.scrollY < maxScroll(window);
  if (!shouldRun && window.tickTimer !== null) {
    clearInterval(window.tickTimer);
    window.tickTimer = null;
  }
  if (shouldRun && window.tickTimer === null) {
    window.lastTickAtMs = Date.now();
    window.tickTimer = setInterval(() => tick(window), RENDER_TICK_MS);
  }
}

function tick(window: MuseWindow): void {
  const now = Date.now();
  const dt = Math.min(0.25, (now - window.lastTickAtMs) / 1000);
  window.lastTickAtMs = now;
  window.scrollY += window.speed * dt;
  if (window.scrollY >= maxScroll(window)) {
    window.scrollY = maxScroll(window);
    window.auto = false;
    syncTickTimer(window);
  }
  renderAndSubmit(window, 0);
}

// --- Input ------------------------------------------------------------------

function handleInput(window: MuseWindow, event: InputEvent, frameId: number): void {
  if (window.menu?.isOpen()) {
    window.menu
      .handleInput(directionalFallback(event))
      .catch((error) => console.error(`muse menu input failed: ${error}`))
      .then(() => renderAndSubmit(window, frameId));
    return;
  }

  if (event.type === "short-then-long-press") {
    window.auto = false;
    syncTickTimer(window);
    windowMenu(window).open();
    renderAndSubmit(window, frameId);
    return;
  }

  const step = directionalFallback(event);
  switch (step.type) {
    case "scroll-up":
      window.auto = false;
      window.scrollY -= MANUAL_STEP;
      clampScroll(window);
      syncTickTimer(window);
      renderAndSubmit(window, frameId);
      return;
    case "scroll-down":
      window.auto = false;
      window.scrollY += MANUAL_STEP;
      clampScroll(window);
      syncTickTimer(window);
      renderAndSubmit(window, frameId);
      return;
    case "click":
      toggleAuto(window);
      renderAndSubmit(window, frameId);
      return;
    default:
      frameTimings.finishFrame(frameId, "discarded: muse ignored input");
      return;
  }
}

function toggleAuto(window: MuseWindow): void {
  if (!window.auto && window.scrollY >= maxScroll(window)) window.scrollY = 0; // replay from top
  window.auto = !window.auto;
  syncTickTimer(window);
}

// --- Menu -------------------------------------------------------------------

function windowMenuItems(window: MuseWindow): MenuItem[] {
  const speedLabel = ["Slow", "Medium", "Brisk", "Fast"][SPEEDS.indexOf(window.speed as (typeof SPEEDS)[number])] ?? "Medium";
  return [
    {
      label: window.auto ? "Pause" : "Play",
      onSelect: (ctx) => {
        ctx.stack.pop();
        toggleAuto(window);
      },
    },
    {
      label: `Speed: ${speedLabel}`,
      onSelect: (ctx) => {
        ctx.stack.pop();
        const i = SPEEDS.indexOf(window.speed as (typeof SPEEDS)[number]);
        window.speed = SPEEDS[(i + 1) % SPEEDS.length]!;
        try {
          setStringSetting(SPEED_KEY, String(window.speed));
        } catch {
          /* best effort */
        }
        syncTickTimer(window);
      },
    },
    {
      label: "Jump to top",
      onSelect: (ctx) => {
        ctx.stack.pop();
        window.scrollY = 0;
        window.auto = false;
        syncTickTimer(window);
      },
    },
    {
      label: "Close",
      onSelect: (ctx) => {
        ctx.stack.pop();
        post({ type: "close-window-request", windowId: window.windowId });
      },
    },
  ];
}

function windowMenu(window: MuseWindow): WindowMenu {
  if (!window.menu) {
    window.menu = new WindowMenu({
      windowId: window.windowId,
      post,
      title: () => window.title,
      items: () => windowMenuItems(window),
      size: { width: window.viewportWidth, height: window.viewportHeight },
      paintBase: () => paintContent(window),
      isFocused: () => window.focused,
    });
  }
  return window.menu;
}

// --- Paint ------------------------------------------------------------------

const STAFF_LEFT = 0; // marginX computed per-window to center the 576px strip

function paintContent(window: MuseWindow): GrayImage {
  const viewW = window.viewportWidth;
  const viewH = window.viewportHeight;
  const frame = new GrayImage(viewW, viewH, 0);
  const marginX = Math.max(STAFF_LEFT, Math.floor((viewW - SCORE.width) / 2));
  const top = Math.round(window.scrollY);

  // Only the bands overlapping [top, top+viewH) touch the wire; each is a
  // cached image draw, so scrolling re-places rather than re-uploads them.
  const first = Math.max(0, Math.floor(top / SCORE.bandHeight));
  const last = Math.min(SCORE.bands.length - 1, Math.floor((top + viewH - 1) / SCORE.bandHeight));
  for (let i = first; i <= last; i++) {
    const y = i * SCORE.bandHeight - top;
    frame.drawImage(SCORE.bands[i]!, marginX, y);
  }

  // Thin right-edge progress bar so you can feel where you are in the hymn.
  const max = maxScroll(window);
  if (max > 0) {
    const barH = Math.max(6, Math.round((viewH * viewH) / SCORE.totalHeight));
    const barY = Math.round((viewH - barH) * (window.scrollY / max));
    frame.fillRect(viewW - 2, barY, 2, barH, window.auto ? 255 : 85);
  }
  return frame;
}

function paint(window: MuseWindow): Plane[] {
  return windowMenu(window).paint();
}

function renderAndSubmit(window: MuseWindow, inputFrameId: number): void {
  const frameId = inputFrameId > 0 ? inputFrameId : frameTimings.startFrame(`render:${window.windowId}`);
  try {
    const paintStartedAtMs = Date.now();
    const planes = frameTimings.span(frameId, "paint", () => frameTimings.runWithFrame(frameId, () => paint(window)));
    const paintMs = Date.now() - paintStartedAtMs;
    const fingerprint = planesFingerprint(planes);
    if (fingerprint === window.lastSubmittedFingerprint) {
      frameTimings.finishFrame(frameId, "discarded: muse content unchanged");
      return;
    }
    const communicator = getActiveDisplay();
    if (!communicator) {
      frameTimings.finishFrame(frameId, "discarded: no active display");
      return;
    }
    const { image, draws } = frameTimings.span(frameId, "flatten", () => flattenPlanesWithDraws(planes));
    const buffer = frameTimings.span(frameId, "to8bpp", () => image.to8bppBuffer());
    communicator.submitSurfaceFrame(
      buffer.buffer,
      window.surfaceId,
      0,
      0,
      image.width,
      image.height,
      fingerprint,
      paintMs,
      frameId,
      frameTimings.span(frameId, "prepareFrameDraws", () => prepareFrameDraws(draws)),
    );
    window.lastSubmittedFingerprint = fingerprint;
  } catch (error) {
    frameTimings.finishFrame(frameId, "discarded: muse render failed");
    console.error(`muse worker render failed: ${error}`);
  }
}

// Touch the imported title so a future header can use it without an unused-import error.
void SAMPLE_TITLE;
