/**
 * Voice-prints: one person's voice as an L2-normalized speaker embedding
 * (3D-Speaker ERes2Net, 192 dimensions). Each person keeps up to two,
 * because someone heard through laptop speakers on a call sounds different
 * from the same person in the room; matching scores against both, and a
 * confirmed sample trains the closer one. Pure, so it runs under node tests.
 *
 * The thresholds come from 40 minutes of glasses audio (a house, a diesel
 * truck, a festival) scored against the wearer's own labels: a run of one
 * voice named at KNOWN with a KNOWN_MARGIN lead was always right, at LIKELY
 * with a LIKELY_MARGIN lead right 96% of the time, and announcers never
 * reached LIKELY against the family's prints.
 */

export type Print = { embedding: number[]; count: number };
export type PersonPrints = { room?: Print; call?: Print };
/** personId → prints; "you" is the wearer. */
export type PrintStore = Record<string, PersonPrints>;
export type PrintKind = "room" | "call";
export type Score = { personId: string; similarity: number };
export type Identity = { personId: string; similarity: number; margin: number; confidence: "high" | "medium" | "low" };

/** Microphones' running-mean cap: later samples still count, at 1/25 weight. */
export const PRINT_WEIGHT_CAP = 24;
/** Two prints of one person in different places score at least about this. */
export const PRINT_SAME = 0.6;
export const KNOWN = 0.5;
export const KNOWN_MARGIN = 0.1;
export const LIKELY = 0.45;
export const LIKELY_MARGIN = 0.05;

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

/** Who a voice is, from its scores (best first): high and medium name someone, low is a guess. */
export function identify(scores: Score[]): Identity | null {
  const [best, second] = scores;
  if (!best) return null;
  const margin = best.similarity - (second?.similarity ?? 0);
  const confidence = best.similarity >= KNOWN && margin >= KNOWN_MARGIN ? "high" : best.similarity >= LIKELY && margin >= LIKELY_MARGIN ? "medium" : "low";
  return { personId: best.personId, similarity: best.similarity, margin, confidence };
}

/** The mean of some embeddings, renormalized (a run of lines as one voice). */
export function pool(embeddings: ArrayLike<number>[]): number[] | null {
  const present = embeddings.filter((embedding) => embedding && embedding.length);
  if (!present.length) return null;
  const sum = new Array<number>(present[0].length).fill(0);
  for (const embedding of present) for (let i = 0; i < sum.length; i++) sum[i] += embedding[i] ?? 0;
  return normalize(sum);
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
  } else if (!next[kind] && next[other] && similarity(sample, next[other]!.embedding) >= PRINT_SAME) {
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
