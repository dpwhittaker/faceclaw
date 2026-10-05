/**
 * The Bible app's three-way picker, after the ring keyboard (see
 * ui/shell/trinary-keyboard.ts): a choice among many items becomes a tree in
 * which every group splits its items into three runs, drawn as three stacked
 * boxes. Swipe up enters the top box, tap the middle, swipe down the bottom;
 * a box holding one item picks it. A range of n items splits into thirds as
 * even as they go (50 chapters: 1-17, 18-34, 35-50), so up to 81 items are
 * four moves away and the screen can show every one of them at once: three
 * boxes of up to 27, each drawn as three rows of nine.
 *
 * Kept free of NativeScript imports so tests can load it under plain node.
 */

export type PickLeaf<T> = {
  readonly kind: "leaf";
  readonly label: string;
  readonly value: T;
};

/** Three slots, top to bottom; null leaves that box empty. */
export type PickSlots<T> = readonly [PickNode<T> | null, PickNode<T> | null, PickNode<T> | null];

export type PickGroup<T> = {
  readonly kind: "group";
  /** The group's name: "Genesis–Job", "1–17". */
  readonly label: string;
  readonly children: PickSlots<T>;
};

export type PickNode<T> = PickLeaf<T> | PickGroup<T>;

export const SLOT_TOP = 0;
export const SLOT_MIDDLE = 1;
export const SLOT_BOTTOM = 2;
export type Slot = typeof SLOT_TOP | typeof SLOT_MIDDLE | typeof SLOT_BOTTOM;

export function leaf<T>(label: string, value: T): PickLeaf<T> {
  return { kind: "leaf", label, value };
}

/**
 * A group over up to three nodes. One node is returned as itself, so no box
 * ever just zooms into the same thing again; two take the top and bottom
 * slots, since swipes are quicker than a tap (the ring waits to rule out a
 * double-tap).
 */
export function group<T>(nodes: ReadonlyArray<PickNode<T>>, label?: string): PickNode<T> {
  if (nodes.length === 0) throw new Error("empty pick group");
  if (nodes.length === 1) return nodes[0]!;
  const children: PickSlots<T> = nodes.length === 2
    ? [nodes[0]!, null, nodes[1]!]
    : [nodes[0]!, nodes[1]!, nodes[2]!];
  return { kind: "group", label: label ?? rangeLabel(children), children };
}

/** Sizes of the three runs n items split into: as even as they go, larger first. */
export function thirds(count: number): [number, number, number] {
  const first = Math.ceil(count / 3);
  const second = Math.ceil((count - first) / 2);
  return [first, second, count - first - second];
}

/** The tree over a run of leaves, split into thirds at every level. */
export function splitThirds<T>(leaves: ReadonlyArray<PickNode<T>>, label?: string): PickNode<T> {
  if (leaves.length <= 3) return group(leaves, label);
  const [a, b] = thirds(leaves.length);
  return group([
    splitThirds(leaves.slice(0, a)),
    splitThirds(leaves.slice(a, a + b)),
    splitThirds(leaves.slice(a + b)),
  ], label);
}

/** The picker over the numbers first..last (chapters, verses). */
export function numberTree(first: number, last: number): PickNode<number> {
  const leaves: PickLeaf<number>[] = [];
  for (let n = first; n <= last; n++) leaves.push(leaf(String(n), n));
  return splitThirds(leaves);
}

/** How many levels a node spans: 0 for a leaf, 1 for a group of leaves, ... */
export function nodeDepth<T>(node: PickNode<T>): number {
  if (node.kind === "leaf") return 0;
  let depth = 0;
  for (const child of node.children) {
    if (child) depth = Math.max(depth, nodeDepth(child));
  }
  return depth + 1;
}

export function firstLeaf<T>(node: PickNode<T>): PickLeaf<T> {
  let current = node;
  while (current.kind === "group") current = (current.children[0] ?? current.children[1] ?? current.children[2])!;
  return current;
}

export function lastLeaf<T>(node: PickNode<T>): PickLeaf<T> {
  let current = node;
  while (current.kind === "group") current = (current.children[2] ?? current.children[1] ?? current.children[0])!;
  return current;
}

/** "1–17": the first and last leaf labels of a group, or the label of a leaf. */
export function rangeLabel<T>(node: PickNode<T> | PickSlots<T>): string {
  const nodes = "kind" in node ? [node] : node.filter((child): child is PickNode<T> => child !== null);
  const first = firstLeaf(nodes[0]!).label;
  const last = lastLeaf(nodes[nodes.length - 1]!).label;
  return first === last ? first : `${first}–${last}`;
}

/** What a gesture did: zoomed in, picked a value, or nothing (an empty box). */
export type PickOutcome<T> =
  | { kind: "moved" }
  | { kind: "picked"; value: T }
  | { kind: "none" };

/**
 * Where the wearer is in one tree: the path from its root to the group whose
 * three children are on screen. Picking never stands on a leaf; it reports it.
 */
export class PickCursor<T> {
  private path: PickNode<T>[];

  constructor(readonly root: PickNode<T>) {
    this.path = [root];
  }

  /** The node on screen: its children are the three boxes (a lone leaf fills one box). */
  current(): PickNode<T> {
    return this.path[this.path.length - 1]!;
  }

  /** The three boxes on screen. A tree of one leaf shows it alone in the middle. */
  slots(): PickSlots<T> {
    const node = this.current();
    return node.kind === "group" ? node.children : [null, node, null];
  }

  isAtRoot(): boolean {
    return this.path.length === 1;
  }

  depth(): number {
    return this.path.length - 1;
  }

  /** Swipe up, tap, swipe down: enter that box, or pick it when it is one item. */
  enter(slot: Slot): PickOutcome<T> {
    const child = this.slots()[slot] ?? null;
    if (!child) return { kind: "none" };
    if (child.kind === "leaf") return { kind: "picked", value: child.value };
    this.path.push(child);
    return { kind: "moved" };
  }

  /** Double-tap: zoom out a level. False at the root. */
  back(): boolean {
    if (this.path.length <= 1) return false;
    this.path.pop();
    return true;
  }
}
