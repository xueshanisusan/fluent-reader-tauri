// Pure logic for the Daily Digest: which unread articles to surface, and how to
// order a fetched set back into the picked sequence. No IO here — kept pure so
// it's unit-testable without a store or the backend.
import type { Item } from "./db-bridge";
import type { DigestConfig, DigestWeights } from "./settings-bridge";

// Sources without a group share this bucket key; its weight is digestWeights[0].
export const UNGROUPED_BUCKET = 0;

// Local calendar date as YYYY-MM-DD. Intentionally NOT UTC (toISOString) — the
// digest freezes/rolls over at the user's local midnight, not UTC's.
export function todayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Order a fetched item set by a stored iid sequence. Items whose iid isn't in
// `iids` are dropped; iids with no matching item (e.g. a deleted source) are
// skipped. This is how the frozen digest reconstitutes its display order after
// items_by_ids returns rows in arbitrary order.
export function reorderByIds<T extends { iid: number }>(
  items: T[],
  iids: number[]
): T[] {
  const byId = new Map<number, T>();
  for (const it of items) byId.set(it.iid, it);
  const out: T[] = [];
  for (const id of iids) {
    const it = byId.get(id);
    if (it) out.push(it);
  }
  return out;
}

// Within a bucket: notify-flagged first (user marked them important via a
// rule), then newest, then higher iid — a total order so selection is
// deterministic (stable tests, stable digests).
function byPriority(a: Item, b: Item): number {
  if (a.notify !== b.notify) return a.notify ? -1 : 1;
  if (a.dateMs !== b.dateMs) return b.dateMs - a.dateMs;
  return b.iid - a.iid;
}

/**
 * Pick a bounded, curated set of iids from `unread`, so reading just these is
 * "enough for today". Strategy: every non-muted group is guaranteed up to
 * `base` items (coverage — don't miss a followed group), then the remaining
 * budget is filled across groups by weight using the Sainte-Laguë
 * highest-averages method (proportional, with natural spill when a bucket runs
 * out). A per-source cap keeps a single prolific feed from dominating. A group
 * weight <= 0 mutes it entirely (no base, no fill). Final order is flat, newest
 * first, so the digest reads like a normal feed.
 */
export function selectDigest(
  unread: Item[],
  groupOf: (sourceId: number) => number | null,
  weights: DigestWeights,
  config: DigestConfig
): number[] {
  const { size, base, perSource } = config;
  if (size <= 0 || unread.length === 0) return [];

  // Bucket items by group (or the ungrouped sentinel), each sorted by priority.
  const buckets = new Map<number, Item[]>();
  for (const it of unread) {
    const key = groupOf(it.sourceId) ?? UNGROUPED_BUCKET;
    const arr = buckets.get(key);
    if (arr) arr.push(it);
    else buckets.set(key, [it]);
  }
  const weightOf = (key: number): number => {
    const w = weights[key];
    return w === undefined ? 1 : w;
  };
  // Ascending key order gives deterministic tie-breaking below.
  const keys = [...buckets.keys()]
    .filter(k => weightOf(k) > 0) // weight <= 0 mutes the whole group
    .sort((a, b) => a - b);
  for (const k of keys) buckets.get(k)!.sort(byPriority);

  const cursor = new Map<number, number>(); // next index to consider per bucket
  const perSourceCount = new Map<number, number>();
  const picked: number[] = [];

  // The next eligible item in a bucket (respecting the per-source cap and the
  // moving cursor), without consuming it. Re-checks the cap each call, so an
  // item that became capped after a sibling was picked is skipped.
  const peek = (key: number): Item | null => {
    const arr = buckets.get(key)!;
    let i = cursor.get(key) ?? 0;
    while (i < arr.length) {
      const it = arr[i];
      if ((perSourceCount.get(it.sourceId) ?? 0) >= perSource) {
        i++; // this source is full — skip permanently
        continue;
      }
      cursor.set(key, i); // park at the first eligible item
      return it;
    }
    cursor.set(key, i);
    return null;
  };
  const consume = (key: number): void => {
    const arr = buckets.get(key)!;
    const i = cursor.get(key)!;
    const it = arr[i];
    picked.push(it.iid);
    perSourceCount.set(it.sourceId, (perSourceCount.get(it.sourceId) ?? 0) + 1);
    cursor.set(key, i + 1);
  };

  // Base pass: coverage for every non-muted group.
  for (const key of keys) {
    let n = 0;
    while (n < base && picked.length < size && peek(key) !== null) {
      consume(key);
      n++;
    }
  }

  // Weighted fill: highest-averages (Sainte-Laguë). Repeatedly award one slot to
  // the bucket with the largest weight/(1+alreadyFilled), among buckets that can
  // still yield one. Ties resolve to the smaller key (keys iterated ascending).
  const fillCount = new Map<number, number>();
  while (picked.length < size) {
    let bestKey: number | null = null;
    let bestScore = -1;
    for (const key of keys) {
      if (peek(key) === null) continue;
      const score = weightOf(key) / (1 + (fillCount.get(key) ?? 0));
      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }
    if (bestKey === null) break; // everything exhausted or capped
    consume(bestKey);
    fillCount.set(bestKey, (fillCount.get(bestKey) ?? 0) + 1);
  }

  // Flat display order: newest first (iid tiebreak), deterministic.
  const chosen = new Set(picked);
  return unread
    .filter(it => chosen.has(it.iid))
    .sort((a, b) => b.dateMs - a.dateMs || b.iid - a.iid)
    .map(it => it.iid);
}
