// Persistence layer for the in-app Logs panel. Mirrors settings-bridge.ts:
// lazy Store.load on first use, single key holding the whole array, fire-and-
// forget save() from the hook. Failures are non-critical — logs are a UX
// nicety, not durable user data.

import { Store } from "@tauri-apps/plugin-store";
import type { LogEntry } from "./log-store";

const STORE_FILE = "logs.json";
const KEY = "entries";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = Store.load(STORE_FILE);
  return storePromise;
}

export const logsApi = {
  async loadAll(): Promise<LogEntry[]> {
    const s = await getStore();
    const v = await s.get<LogEntry[]>(KEY);
    return Array.isArray(v) ? v : [];
  },
  async save(entries: ReadonlyArray<LogEntry>): Promise<void> {
    const s = await getStore();
    await s.set(KEY, entries);
    await s.save();
  },
  async clear(): Promise<void> {
    const s = await getStore();
    await s.delete(KEY);
    await s.save();
  },
};
