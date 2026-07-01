// Periodic auto-refresh: every TICK_INTERVAL_MS, fetch sources whose
// fetchFrequency has elapsed since lastFetchedMs and ingest them through
// the existing refreshAll worker pool. Pauses while the document is hidden.

import { sources as sourcesApi, type Source } from "./db-bridge";
import { refreshAll, type RefreshResult } from "./feeds";

const DEFAULT_TICK_INTERVAL_MS = 60_000;

export interface AutoRefreshOptions {
  tickIntervalMs?: number;
  concurrency?: number;
  onTick?: (results: RefreshResult[]) => void;
  onError?: (err: unknown) => void;
}

// fetchFrequency is minutes (0 = disabled). spike:// URLs are demo seeds and
// have no real feed behind them, so they never qualify. Remote sources
// (serviceRef != null) pull their items through the sync service, never via
// RSS refresh — excluding them here avoids a double fetch.
export function computeDueSources(sources: Source[], nowMs: number): number[] {
  const out: number[] = [];
  for (const s of sources) {
    if (s.serviceRef != null) continue;
    if (s.fetchFrequency <= 0) continue;
    if (s.url.startsWith("spike://")) continue;
    if (nowMs - s.lastFetchedMs >= s.fetchFrequency * 60_000) {
      out.push(s.sid);
    }
  }
  return out;
}

export function startAutoRefresh(opts: AutoRefreshOptions = {}): () => void {
  const tickMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  let stopped = false;
  let tickInFlight = false;

  async function runTick(): Promise<void> {
    if (stopped || tickInFlight) return;
    if (typeof document !== "undefined" && document.hidden) return;
    tickInFlight = true;
    try {
      const all = await sourcesApi.list();
      const due = computeDueSources(all, Date.now());
      if (due.length === 0) return;
      const results = await refreshAll(due, { concurrency: opts.concurrency });
      if (!stopped && opts.onTick) opts.onTick(results);
    } catch (e) {
      if (!stopped && opts.onError) opts.onError(e);
    } finally {
      tickInFlight = false;
    }
  }

  const handle = window.setInterval(() => {
    void runTick();
  }, tickMs);

  function onVisibility(): void {
    if (!document.hidden) void runTick();
  }
  document.addEventListener("visibilitychange", onVisibility);

  // Kick once immediately so freshly-opened windows don't wait a full tick.
  void runTick();

  return () => {
    stopped = true;
    window.clearInterval(handle);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
