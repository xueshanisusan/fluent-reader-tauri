// Typed wrapper around the Rust sync-service commands. Fever only for now.
// The Fever api_key (md5(user:pass)) is stored in the OS keychain by the
// backend and never crosses this bridge — only non-secret config (endpoint,
// username, fetchLimit) is persisted in the settings store by the caller.
import { invoke } from "@tauri-apps/api/core";

export type SyncError =
  | { kind: "network"; message: string }
  | { kind: "parse"; message: string }
  | { kind: "keyring"; message: string }
  | { kind: "db"; message: string };

export interface FeverAuthInput {
  endpoint: string;
  username: string;
  password: string;
}

/** Outcome of a full sync: source reconciliation (updateSources) + item pull. */
export interface SyncResult {
  added: number;
  adopted: number;
  removed: number;
  grouped: number;
  /** Items freshly inserted by the item pull. */
  fetched: number;
  /** Advanced incremental-fetch cursor — persist into the stored FeverConfigs. */
  lastId: number;
  useInt32: boolean;
}

export const service = {
  /**
   * Verify Fever credentials. On success the derived api_key is stored in the
   * OS keychain. Resolves to whether the server accepted the credentials.
   */
  authenticate(input: FeverAuthInput): Promise<boolean> {
    return invoke<boolean>("service_authenticate", { input });
  },
  /** Forget the stored Fever credentials (on service removal). */
  forget(): Promise<void> {
    return invoke<void>("service_forget");
  },
  /**
   * Full sync: reconcile local sources with the Fever service's subscriptions,
   * then pull items newer than `lastId`. The api_key is read from the OS keychain
   * by the backend; pass the stored endpoint, `fetchLimit`, and incremental
   * cursor (`lastId`/`useInt32`). When `importGroups` is true the server's
   * categories are imported and synced sources assigned to them (a one-time
   * opt-in — the caller clears the flag afterward). The returned `lastId`/
   * `useInt32` must be persisted back into the stored FeverConfigs.
   */
  sync(
    endpoint: string,
    importGroups: boolean,
    fetchLimit: number,
    lastId: number,
    useInt32: boolean
  ): Promise<SyncResult> {
    return invoke<SyncResult>("service_sync", {
      endpoint,
      importGroups,
      fetchLimit,
      lastId,
      useInt32,
    });
  },
};

/** Best-effort human-readable message from a rejected service command. */
export function describeSyncError(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
