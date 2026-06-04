// Frontend orchestrator: schedules per-source ingest with bounded concurrency.
// The Rust command owns one source's full pipeline; this layer just dispatches.

import { feeds, IngestionError, IngestionOutcome } from "./feeds-bridge";

export interface RefreshSuccess {
  sid: number;
  outcome: IngestionOutcome;
}

export interface RefreshFailure {
  sid: number;
  error: IngestionError | { kind: "unknown"; message: string };
}

export type RefreshResult = RefreshSuccess | RefreshFailure;

export function isRefreshSuccess(r: RefreshResult): r is RefreshSuccess {
  return "outcome" in r;
}

function normalizeError(e: unknown): RefreshFailure["error"] {
  if (e && typeof e === "object" && "kind" in e) {
    const k = (e as { kind: unknown }).kind;
    if (k === "network" || k === "parse" || k === "db") {
      return e as IngestionError;
    }
  }
  return { kind: "unknown", message: String((e as Error)?.message ?? e) };
}

export async function refreshAll(
  sids: number[],
  opts: { concurrency?: number } = {}
): Promise<RefreshResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const results: RefreshResult[] = new Array(sids.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= sids.length) return;
      const sid = sids[i];
      try {
        const outcome = await feeds.ingest(sid);
        results[i] = { sid, outcome };
      } catch (e) {
        results[i] = { sid, error: normalizeError(e) };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, sids.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
