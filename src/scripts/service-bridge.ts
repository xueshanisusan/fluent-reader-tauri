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

/** Outcome of a source reconciliation (updateSources). */
export interface SyncResult {
  added: number;
  adopted: number;
  removed: number;
  grouped: number;
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
   * Reconcile local sources with the Fever service's subscriptions. The api_key
   * is read from the OS keychain by the backend; pass the stored endpoint. When
   * `importGroups` is true the server's categories are imported and synced
   * sources assigned to them (a one-time opt-in — clear the flag afterward).
   */
  sync(endpoint: string, importGroups: boolean): Promise<SyncResult> {
    return invoke<SyncResult>("service_sync", { endpoint, importGroups });
  },
};

/** Best-effort human-readable message from a rejected service command. */
export function describeSyncError(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
