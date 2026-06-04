// Typed wrappers around Tauri invoke commands declared in src-tauri/src/commands.rs.
// Backend serializes with serde rename_all = "camelCase"; types here mirror that.

import { invoke } from "@tauri-apps/api/core";

export interface Group {
  gid: number;
  name: string;
  expanded: boolean;
  position: number;
}

export interface Source {
  sid: number;
  url: string;
  iconUrl: string | null;
  name: string;
  openTarget: number;
  lastFetchedMs: number;
  serviceRef: string | null;
  fetchFrequency: number;
  textDir: number;
  hidden: boolean;
  groupId: number | null;
  position: number;
  etag: string | null;
  lastModified: string | null;
}

export interface NewSource {
  url: string;
  name: string;
  iconUrl?: string | null;
  groupId?: number | null;
  openTarget?: number;
  fetchFrequency?: number;
  textDir?: number;
}

export interface SourceRule {
  rid: number;
  sourceId: number;
  position: number;
  filterTypeMask: number;
  filterSearch: string;
  filterMatch: boolean;
  actionRead: number | null;
  actionStar: number | null;
  actionHide: number | null;
  actionNotify: number | null;
}

export interface NewRule {
  sourceId: number;
  position: number;
  filterTypeMask: number;
  filterSearch: string;
  filterMatch: boolean;
  actionRead?: number | null;
  actionStar?: number | null;
  actionHide?: number | null;
  actionNotify?: number | null;
}

export type RulePatch = Omit<NewRule, "sourceId">;

export interface Item {
  iid: number;
  sourceId: number;
  title: string;
  link: string;
  dateMs: number;
  fetchedDateMs: number;
  thumb: string | null;
  content: string;
  snippet: string;
  creator: string | null;
  hasRead: boolean;
  starred: boolean;
  hidden: boolean;
  notify: boolean;
  serviceRef: string | null;
}

export interface NewItem {
  sourceId: number;
  title: string;
  link: string;
  dateMs: number;
  thumb?: string | null;
  content?: string | null;
  snippet?: string | null;
  creator?: string | null;
}

export interface UnreadCount {
  sourceId: number;
  count: number;
}

export interface ItemListFilter {
  sourceId?: number;
  hasRead?: boolean;
  starred?: boolean;
  limit?: number;
  offset?: number;
}

export const groups = {
  list: () => invoke<Group[]>("groups_list"),
  create: (name: string) => invoke<Group>("groups_create", { name }),
  rename: (gid: number, name: string) =>
    invoke<void>("groups_rename", { gid, name }),
  setExpanded: (gid: number, expanded: boolean) =>
    invoke<void>("groups_set_expanded", { gid, expanded }),
  setPosition: (gid: number, position: number) =>
    invoke<void>("groups_set_position", { gid, position }),
  delete: (gid: number) => invoke<void>("groups_delete", { gid }),
};

export const sources = {
  list: () => invoke<Source[]>("sources_list"),
  create: (input: NewSource) => invoke<Source>("sources_create", { input }),
  rename: (sid: number, name: string) =>
    invoke<void>("sources_rename", { sid, name }),
  setGroup: (sid: number, groupId: number | null) =>
    invoke<void>("sources_set_group", { sid, groupId }),
  setIconUrl: (sid: number, iconUrl: string | null) =>
    invoke<void>("sources_set_icon_url", { sid, iconUrl }),
  setFetchFrequency: (sid: number, fetchFrequency: number) =>
    invoke<void>("sources_set_fetch_frequency", { sid, fetchFrequency }),
  setHidden: (sid: number, hidden: boolean) =>
    invoke<void>("sources_set_hidden", { sid, hidden }),
  setLastFetched: (sid: number, lastFetchedMs: number) =>
    invoke<void>("sources_set_last_fetched", { sid, lastFetchedMs }),
  delete: (sid: number) => invoke<void>("sources_delete", { sid }),
};

export const rules = {
  list: (sourceId: number) => invoke<SourceRule[]>("rules_list", { sourceId }),
  create: (input: NewRule) => invoke<SourceRule>("rules_create", { input }),
  update: (rid: number, patch: RulePatch) =>
    invoke<void>("rules_update", { rid, patch }),
  delete: (rid: number) => invoke<void>("rules_delete", { rid }),
};

export const items = {
  list: (filter: ItemListFilter = {}) =>
    invoke<Item[]>("items_list", {
      sourceId: filter.sourceId ?? null,
      hasRead: filter.hasRead ?? null,
      starred: filter.starred ?? null,
      limit: filter.limit ?? 100,
      offset: filter.offset ?? 0,
    }),
  insert: (newItems: NewItem[]) =>
    invoke<number>("items_insert", { items: newItems }),
  markRead: (iid: number, hasRead: boolean) =>
    invoke<void>("items_mark_read", { iid, hasRead }),
  setStarred: (iid: number, starred: boolean) =>
    invoke<void>("items_set_starred", { iid, starred }),
  unreadCounts: () => invoke<UnreadCount[]>("items_unread_counts"),
};
