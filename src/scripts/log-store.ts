// In-app log history for the bell-icon Logs flyout. State is hydrated from
// tauri-plugin-store on first mount; every mutation fires a fire-and-forget
// save. Ring-buffer capped at LOG_CAP so persistence stays bounded.
//
// Hydration race: auto-refresh kicks an immediate tick on mount (see
// auto-refresh.ts:63) which may produce log entries before loadAll() resolves.
// We guard against the load callback clobbering those by only writing the
// loaded entries when the current state is still empty AND no append has
// occurred (tracked via appendedRef).

import * as React from "react";
import type { RefreshResult } from "./feeds";
import type { ImportSummary } from "./feeds-bridge";
import { logsApi } from "./logs-bridge";

export const LOG_CAP = 100;

export interface LogEntryBase {
  id: string;
  ts: number;
}

export type LogEntry =
  | (LogEntryBase & {
      kind: "refresh-success";
      sourceId: number;
      sourceName: string;
      outcome:
        | { kind: "updated"; inserted: number }
        | { kind: "notModified" };
      trigger: "manual" | "auto";
    })
  | (LogEntryBase & {
      kind: "refresh-error";
      sourceId: number;
      sourceName: string;
      error: { kind: string; message: string };
      trigger: "manual" | "auto";
    })
  | (LogEntryBase & {
      kind: "opml-import";
      summary: ImportSummary;
    })
  | (LogEntryBase & {
      kind: "opml-import-error";
      error: { kind: string; message: string };
    })
  | (LogEntryBase & {
      kind: "opml-export-success";
      bytes: number;
    })
  | (LogEntryBase & {
      kind: "opml-export-error";
      error: { kind: string; message: string };
    });

// Pure helper: prepend `adds` (already in newest-first order within the batch)
// to `prev`, then clamp to `cap`. Exported for unit tests.
export function appendCapped(
  prev: ReadonlyArray<LogEntry>,
  adds: ReadonlyArray<LogEntry>,
  cap: number = LOG_CAP
): LogEntry[] {
  if (cap <= 0) return [];
  return [...adds, ...prev].slice(0, cap);
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function entryFromRefresh(
  r: RefreshResult,
  names: ReadonlyMap<number, string>,
  trigger: "manual" | "auto"
): LogEntry {
  const sourceName = names.get(r.sid) ?? `source #${r.sid}`;
  const base = { id: newId(), ts: Date.now() };
  if ("outcome" in r) {
    const outcome =
      r.outcome.kind === "updated"
        ? { kind: "updated" as const, inserted: r.outcome.inserted }
        : { kind: "notModified" as const };
    return {
      ...base,
      kind: "refresh-success",
      sourceId: r.sid,
      sourceName,
      outcome,
      trigger,
    };
  }
  return {
    ...base,
    kind: "refresh-error",
    sourceId: r.sid,
    sourceName,
    error: { kind: r.error.kind, message: r.error.message },
    trigger,
  };
}

export interface LogStoreApi {
  entries: ReadonlyArray<LogEntry>;
  appendRefreshResults: (
    results: RefreshResult[],
    names: ReadonlyMap<number, string>,
    trigger: "manual" | "auto"
  ) => void;
  appendOpmlImport: (summary: ImportSummary) => void;
  appendOpmlImportError: (err: { kind?: string; message: string }) => void;
  appendOpmlExportSuccess: (bytes: number) => void;
  appendOpmlExportError: (err: { kind?: string; message: string }) => void;
  clear: () => void;
}

export function useLogStore(): LogStoreApi {
  const [entries, setEntries] = React.useState<ReadonlyArray<LogEntry>>([]);
  const appendedRef = React.useRef(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await logsApi.loadAll();
        if (cancelled) return;
        setEntries(prev => (appendedRef.current || prev.length > 0 ? prev : loaded));
      } catch (e) {
        console.error("[log-store] load failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = React.useCallback((next: ReadonlyArray<LogEntry>) => {
    void logsApi.save(next).catch(e => console.error("[log-store] save failed", e));
  }, []);

  const appendBatch = React.useCallback(
    (adds: LogEntry[]) => {
      if (adds.length === 0) return;
      appendedRef.current = true;
      setEntries(prev => {
        const next = appendCapped(prev, adds);
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const appendRefreshResults = React.useCallback(
    (
      results: RefreshResult[],
      names: ReadonlyMap<number, string>,
      trigger: "manual" | "auto"
    ) => {
      if (results.length === 0) return;
      const adds = results.map(r => entryFromRefresh(r, names, trigger)).reverse();
      appendBatch(adds);
    },
    [appendBatch]
  );

  const appendOpmlImport = React.useCallback(
    (summary: ImportSummary) => {
      appendBatch([
        { id: newId(), ts: Date.now(), kind: "opml-import", summary },
      ]);
    },
    [appendBatch]
  );

  const appendOpmlImportError = React.useCallback(
    (err: { kind?: string; message: string }) => {
      appendBatch([
        {
          id: newId(),
          ts: Date.now(),
          kind: "opml-import-error",
          error: { kind: err.kind ?? "unknown", message: err.message },
        },
      ]);
    },
    [appendBatch]
  );

  const appendOpmlExportSuccess = React.useCallback(
    (bytes: number) => {
      appendBatch([
        { id: newId(), ts: Date.now(), kind: "opml-export-success", bytes },
      ]);
    },
    [appendBatch]
  );

  const appendOpmlExportError = React.useCallback(
    (err: { kind?: string; message: string }) => {
      appendBatch([
        {
          id: newId(),
          ts: Date.now(),
          kind: "opml-export-error",
          error: { kind: err.kind ?? "unknown", message: err.message },
        },
      ]);
    },
    [appendBatch]
  );

  const clear = React.useCallback(() => {
    appendedRef.current = true;
    setEntries([]);
    void logsApi.clear().catch(e => console.error("[log-store] clear failed", e));
  }, []);

  return {
    entries,
    appendRefreshResults,
    appendOpmlImport,
    appendOpmlImportError,
    appendOpmlExportSuccess,
    appendOpmlExportError,
    clear,
  };
}
