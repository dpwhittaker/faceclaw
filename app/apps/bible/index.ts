import { type AppDefinition } from "../app-definition";
import { BIBLE_SURFACE_ID, BIBLE_WINDOW_ID, createBibleAppWindow } from "./bible-app";

const bibleApp: AppDefinition = {
  appId: "bible",
  title: "Bible",
  icon: "book-open",
  launch: (ctx) =>
    ctx.launchInProcessApp(BIBLE_WINDOW_ID, BIBLE_SURFACE_ID, (options) =>
      createBibleAppWindow({ ...options, appendLog: (message) => ctx.appendLog(message) }),
    ),
};

export default bibleApp;
