/**
 * Voice-prints: one person's voice as an L2-normalized speaker embedding
 * (WeSpeaker CAM++, the model Microphones uses). Each person keeps up to two,
 * because someone heard through laptop speakers on a call sounds different
 * from the same person in the room; matching scores against both, and a
 * confirmed sample trains the closer one. Pure, so it runs under node tests.
 */

export type Print = { embedding: number[]; count: number };
export type PersonPrints = { room?: Print; call?: Print };
/** personId → prints; "you" is the wearer. */
export type PrintStore = Record<string, PersonPrints>;
export type PrintKind = "room" | "call";
export type Score = { personId: string; similarity: number };

/** Microphones' running-mean cap: later samples still count, at 1/25 weight. */
export const PRINT_WEIGHT_CAP = 24;
/** Below this a voice is no one Cue knows (Microphones' "new speaker" line). */
export const PRINT_UNCERTAIN = 0.5;
/** At or above this, the same voice (Microphones' "known"). */
export const PRINT_KNOWN = 0.8;

export function similarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function normalize(vector: ArrayLike<number>): number[] {
  let norm = 0;
  for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(vector, (value) => value / norm);
}

/** How closely an embedding matches each candidate (their better print), best first. */
export function scoreCandidates(embedding: ArrayLike<number>, store: PrintStore, candidates: string[]): Score[] {
  const scores: Score[] = [];
  for (const personId of new Set(candidates)) {
    const prints = store[personId];
    if (!prints) continue;
    const best = Math.max(...[prints.room, prints.call].filter((print): print is Print => Boolean(print)).map((print) => similarity(embedding, print.embedding)));
    if (Number.isFinite(best)) scores.push({ personId, similarity: best });
  }
  return scores.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Folds a confirmed sample into a person's prints and returns the new
 * prints. The closer existing print learns from it; a person with no print
 * of `kind` gets one when the sample doesn't sound like their other print.
 */
export function trainPrint(prints: PersonPrints | undefined, embedding: ArrayLike<number>, kind: PrintKind): PersonPrints {
  const sample = normalize(embedding);
  const next: PersonPrints = { ...prints };
  const other: PrintKind = kind === "room" ? "call" : "room";
  let target: PrintKind = kind;
  if (next[kind] && next[other]) {
    target = similarity(sample, next[other]!.embedding) > similarity(sample, next[kind]!.embedding) ? other : kind;
  } else if (!next[kind] && next[other] && similarity(sample, next[other]!.embedding) >= PRINT_KNOWN) {
    target = other;
  }
  const current = next[target];
  if (!current || current.embedding.length !== sample.length) {
    next[target] = { embedding: sample, count: 1 };
    return next;
  }
  const weight = Math.min(current.count, PRINT_WEIGHT_CAP);
  const merged = current.embedding.map((value, i) => (value * weight + sample[i]) / (weight + 1));
  next[target] = { embedding: normalize(merged), count: current.count + 1 };
  return next;
}

/** "call" for a meeting on Teams or Zoom (voices through laptop speakers), else "room". */
export function printKindFor(location: string | undefined): PrintKind {
  return /teams|zoom|meet\.google|webex/i.test(location ?? "") ? "call" : "room";
}
