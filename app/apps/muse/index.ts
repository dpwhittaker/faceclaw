import { launchWorkerAppWindow, type AppDefinition } from "../app-definition";

/**
 * Muse — a sheet-music reader for the G2, ported from the sheet-music-test
 * EvenHub app but built for faceclaw CFW. Where the EvenHub version showed two
 * systems at a time on a 2x2 grid and highlighted the half you were singing
 * (because stock can only re-upload whole image containers), Muse engraves the
 * whole hymn once and smooth-scrolls it: each system is a cached image draw, so
 * scrolling costs a tiny placement record per band rather than a re-send.
 *
 * Controls: scroll-up/down (ring scroll or watch crown) nudge the score; click
 * toggles auto-scroll; tap-then-long opens the window menu (speed, jump to top).
 */
const museApp: AppDefinition = {
  appId: "muse",
  title: "Muse",
  icon: "music",
  launch: (ctx) =>
    launchWorkerAppWindow(ctx, {
      createWorker: () => new Worker("./muse-app.worker"),
      windowId: "muse:main",
      title: "Muse",
      iconLetter: "M",
      icon: "music",
      acceptsDirectional: true,
    }),
};

export default museApp;
