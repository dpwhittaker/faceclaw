import { type AppDefinition } from "../app-definition";
import { createCueAppWindow, CUE_SURFACE_ID, CUE_WINDOW_ID } from "./cue-app";

const cueApp: AppDefinition = {
  appId: "cue",
  title: "Cue",
  icon: "message-circle",
  launch: (ctx) => ctx.launchInProcessApp(CUE_WINDOW_ID, CUE_SURFACE_ID, (options) => createCueAppWindow(options)),
};

export default cueApp;
