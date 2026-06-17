// Typed wrapper around the sources_ingest tauri command (src-tauri/src/feeds.rs).
// Success/error are both serde-tagged enums; switch on .kind to discriminate.

import { invoke } from "@tauri-apps/api/core";

export type IngestionOutcome =
  | { kind: "notModified"; finalUrl: string }
  | { kind: "updated"; inserted: number; skipped: number; finalUrl: string };

export type IngestionError =
  | { kind: "network"; message: string }
  | { kind: "parse"; message: string }
  | { kind: "db"; message: string };

export interface DiscoveredFeed {
  url: string;
  title: string | null;
}

export type DiscoveryError =
  | { kind: "network"; message: string }
  | { kind: "notFound"; message: string };

export interface ImportSummary {
  groupsCreated: number;
  sourcesAdded: number;
  sourcesSkipped: number;
}

export type OpmlError =
  | { kind: "parse"; message: string }
  | { kind: "db"; message: string };

export const feeds = {
  ingest: (sid: number) =>
    invoke<IngestionOutcome>("sources_ingest", { sid }),
  discover: (url: string) =>
    invoke<DiscoveredFeed[]>("feeds_discover", { url }),
  importOpml: (xml: string) =>
    invoke<ImportSummary>("feeds_import_opml", { xml }),
  exportOpml: () => invoke<string>("feeds_export_opml"),
};
