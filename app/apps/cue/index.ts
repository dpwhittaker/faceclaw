import { ensureCuePermissions } from "../../g2/android-permissions";
import { type AppDefinition } from "../app-definition";
import { createCueAppWindow, CUE_SURFACE_ID, CUE_WINDOW_ID } from "./cue-app";
import { cueLink } from "./cue-link";
import { termuxInstalled } from "./cue-termux";

const cueApp: AppDefinition = {
  appId: "cue",
  title: "Cue",
  icon: "message-circle",
  // Cue triages notifications and keeps the work calendar whether or not
  // its window is open.
  boot: () => {
    cueLink.start();
    if (global.isAndroid) void ensureCuePermissions(termuxInstalled());
  },
  launch: (ctx) => ctx.launchInProcessApp(CUE_WINDOW_ID, CUE_SURFACE_ID, (options) => createCueAppWindow(options)),
};

export default cueApp;
