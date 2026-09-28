import { TRANSCRIPT_PAUSE_MS } from "./speech-pause";

export type TranscriptToken = { text: string; start_ms?: number; end_ms?: number; speaker?: string };

/** A separate presentation buffer keeps paragraph breaks out of dictation. */
export class TimedTranscript {
  text = "";
  private endMs: number | undefined;
  private speaker: string | undefined;

  copy(): TimedTranscript {
    const copy = new TimedTranscript();
    copy.text = this.text;
    copy.endMs = this.endMs;
    copy.speaker = this.speaker;
    return copy;
  }

  append(token: TranscriptToken): void {
    const changedSpeaker = token.speaker != null && this.speaker != null && token.speaker !== this.speaker;
    const paused = token.start_ms != null && this.endMs != null && token.start_ms - this.endMs >= TRANSCRIPT_PAUSE_MS;
    if (token.text.trim() && this.text && (changedSpeaker || paused)) {
      this.text = `${this.text.trimEnd()}\n${token.text.trimStart()}`;
    } else {
      this.text += token.text;
    }
    if (token.text.trim()) {
      if (token.end_ms != null) this.endMs = token.end_ms;
      if (token.speaker != null) this.speaker = token.speaker;
    }
  }
}

/** One speaker's run of words in a diarized transcript. */
export type SpeakerSegment = {
  /**
   * The provider's diarization label ("1", "2", ...), "" when unlabelled.
   * Labels restart with every provider session: compare them only within one stream.
   */
  speaker: string;
  /** The provider session the label belongs to; a reconnect starts a new one. */
  stream: number;
  text: string;
  /** Wall-clock time (epoch ms) the run was spoken, from the audio's own clock. */
  startMs: number;
  endMs: number;
};

type SpeakerRun = { speaker: string; text: string; startMs?: number; endMs?: number };

/**
 * Groups a provider's tokens into runs of one speaker, keeping each run's
 * timing relative to the provider's first audio until segments() anchors it.
 */
export class SpeakerRuns {
  private runs: SpeakerRun[] = [];

  copy(): SpeakerRuns {
    const copy = new SpeakerRuns();
    copy.runs = this.runs.map((run) => ({ ...run }));
    return copy;
  }

  append(token: TranscriptToken): void {
    const spoken = token.text.trim() !== "";
    const last = this.runs[this.runs.length - 1];
    // An unlabelled token carries on the current speaker's run.
    const speaker = token.speaker ?? last?.speaker ?? "";
    if (spoken && (!last || last.speaker !== speaker)) {
      this.runs.push({ speaker, text: token.text, startMs: token.start_ms, endMs: token.end_ms });
    } else if (last) {
      // Whitespace joins the current run whoever speaks next.
      last.text += token.text;
      if (spoken) {
        last.startMs ??= token.start_ms;
        if (token.end_ms != null) last.endMs = token.end_ms;
      }
    }
  }

  /** The runs with text trimmed and times moved onto the wall clock (originMs = the stream's first audio). */
  segments(originMs: number, stream: number): SpeakerSegment[] {
    return this.runs.map((run) => {
      const startMs = originMs + (run.startMs ?? 0);
      return { speaker: run.speaker, stream, text: run.text.trim(), startMs, endMs: Math.max(startMs, originMs + (run.endMs ?? 0)) };
    });
  }
}
