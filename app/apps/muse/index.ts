import { type AppDefinition } from "../app-definition";
import { createMuseAppWindow, MUSE_SURFACE_ID, MUSE_WINDOW_ID } from "./muse-app";

/**
 * Muse — a reader for songs and spoken text on the G2: Markdown files with
 * ABC sheet music in them, plain text, or ABC files. It scrolls smoothly
 * (each line of text and system of music goes to the glasses once, then
 * just moves) and follows your voice through the words and the lyrics.
 */
const museApp: AppDefinition = {
  appId: "muse",
  title: "Muse",
  icon: "music",
  launch: (ctx) =>
    ctx.launchInProcessApp(MUSE_WINDOW_ID, MUSE_SURFACE_ID, (options) =>
      createMuseAppWindow({
        ...options,
        startContinuousVoiceCapture: () => void options.actions.startContinuousVoiceCapture(),
        stopContinuousVoiceCapture: () => void options.actions.stopContinuousVoiceCapture(),
        appendLog: (message) => ctx.appendLog(message),
      }),
    ),
};

export default museApp;
