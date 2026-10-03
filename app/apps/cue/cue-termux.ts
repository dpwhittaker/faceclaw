import { Utils } from "@nativescript/core";
import { hasTermuxRunCommandPermission } from "../../g2/android-permissions";
import { cueBackendUrlSetting, cueTermuxCommandSetting } from "./cue-settings";

declare const android: any;
declare const androidx: any;

const CHECK_MS = 60_000;
const HEALTH_TIMEOUT_MS = 3_000;
/** Failed checks in a row before starting the backend. */
const FAILURES_BEFORE_START = 2;
/** How long a start gets before another is tried. */
const START_GRACE_MS = 3 * 60_000;

/**
 * Keeps Cue's backend running in Termux when it lives on this phone: every
 * minute, unless the connection is up, it asks the backend's /health; after
 * two failures it has Termux run the start script (Termux's RUN_COMMAND,
 * which needs allow-external-apps = true in ~/.termux/termux.properties).
 * Does nothing for a backend elsewhere (a home server).
 */
export class CueTermuxSupervisor {
  private failures = 0;
  private lastStartMs = 0;
  private checking = false;

  constructor(
    private readonly connected: () => boolean,
    private readonly report: (detail: string) => void,
  ) {}

  start(): void {
    setInterval(() => void this.check(), CHECK_MS);
  }

  /** The local port when the backend address is this phone, else null. */
  private localPort(): number | null {
    const match = /^wss?:\/\/(127\.0\.0\.1|localhost)(?::(\d+))?/i.exec(cueBackendUrlSetting.get());
    return match ? Number(match[2] ?? 80) : null;
  }

  private async check(): Promise<void> {
    const port = this.localPort();
    const command = cueTermuxCommandSetting.get();
    if (port === null || !command || this.checking) return;
    if (this.connected()) {
      this.failures = 0;
      return;
    }
    this.checking = true;
    try {
      const healthy = await health(port);
      this.failures = healthy ? 0 : this.failures + 1;
      if (this.failures >= FAILURES_BEFORE_START && Date.now() - this.lastStartMs >= START_GRACE_MS) {
        this.lastStartMs = Date.now();
        this.report(this.run(command) ? "Starting Cue's backend in Termux..." : "Cue's backend is down and Termux couldn't be asked to start it.");
      }
    } finally {
      this.checking = false;
    }
  }

  private run(command: string): boolean {
    if (!hasTermuxRunCommandPermission()) {
      console.warn("[Cue] Termux: Faceclaw lacks the Run commands in Termux permission");
      return false;
    }
    try {
      const context = Utils.android.getApplicationContext();
      const intent = new android.content.Intent();
      intent.setClassName("com.termux", "com.termux.app.RunCommandService");
      intent.setAction("com.termux.RUN_COMMAND");
      intent.putExtra("com.termux.RUN_COMMAND_PATH", command);
      intent.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
      androidx.core.content.ContextCompat.startForegroundService(context, intent);
      console.log(`[Cue] Termux: asked to run ${command}`);
      return true;
    } catch (error) {
      console.warn(`[Cue] Termux: couldn't run ${command}: ${String(error)}`);
      return false;
    }
  }
}

async function health(port: number): Promise<boolean> {
  try {
    const response = await Promise.race([
      fetch(`http://127.0.0.1:${port}/health`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), HEALTH_TIMEOUT_MS)),
    ]);
    return response.ok;
  } catch {
    return false;
  }
}

/** Whether Termux is installed (so its permission can be asked for). */
export function termuxInstalled(): boolean {
  try {
    Utils.android.getApplicationContext().getPackageManager().getPackageInfo("com.termux", 0);
    return true;
  } catch {
    return false;
  }
}
