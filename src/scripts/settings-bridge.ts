// Typed wrapper around tauri-plugin-store. Mirrors the keys the Electron
// version persisted via electron-store, minus dropped state (sourceGroups
// now lives in sqlite, useNeDB is gone, version is unused). Keys are
// per-entry so callers can read/write a single setting without dragging
// the whole blob through IPC.

import { Store } from "@tauri-apps/plugin-store";

export const enum ViewType {
  Cards = 0,
  List = 1,
  Magazine = 2,
  Compact = 3,
  Customized = 4,
}

// True for the flow-wrapped tile/grid feeds (Cards, Magazine), false for the
// vertical-list feeds (List, Compact). All views open the article in an
// overlay; this only selects the ItemList container layout, not the app layout.
export function isGridView(v: ViewType): boolean {
  return v === ViewType.Cards || v === ViewType.Magazine;
}

export const enum ViewConfigs {
  ShowCover = 1,
  ShowSnippet = 2,
  FadeRead = 4,
}

export const enum ThemeSettings {
  Default = "system",
  Light = "light",
  Dark = "dark",
}

export const enum SearchEngines {
  Google = 0,
  Bing = 1,
  Baidu = 2,
  DuckDuckGo = 3,
}

export const enum SyncService {
  None = 0,
  Fever = 1,
  Feedbin = 2,
  GReader = 3,
  Inoreader = 4,
  Miniflux = 5,
  Nextcloud = 6,
}

export interface ServiceConfigs {
  type: SyncService;
  importGroups?: boolean;
  [extra: string]: unknown;
}

export interface FeverConfigs extends ServiceConfigs {
  type: SyncService.Fever;
  endpoint: string;
  username: string;
  fetchLimit: number;
  // Incremental-fetch cursor, advanced by the backend during item sync.
  lastId?: number;
  useInt32?: boolean;
}

export interface SettingsShape {
  theme: ThemeSettings;
  pac: string;
  pacOn: boolean;
  view: ViewType;
  locale: string;
  fontSize: number;
  fontFamily: string;
  menuOn: boolean;
  fetchInterval: number;
  searchEngine: SearchEngines;
  serviceConfigs: ServiceConfigs;
  filterType: number | null;
  listViewConfigs: ViewConfigs;
  menuUnreadSourcesOnly: boolean;
  notificationsEnabled: boolean;
}

const DEFAULTS: SettingsShape = {
  theme: ThemeSettings.Default,
  pac: "",
  pacOn: false,
  view: ViewType.Cards,
  locale: "default",
  fontSize: 16,
  fontFamily: "",
  menuOn: false,
  fetchInterval: 0,
  searchEngine: SearchEngines.Google,
  serviceConfigs: { type: SyncService.None },
  filterType: null,
  listViewConfigs: ViewConfigs.ShowCover,
  menuUnreadSourcesOnly: false,
  notificationsEnabled: true,
};

const STORE_FILE = "settings.json";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = Store.load(STORE_FILE);
  return storePromise;
}

export const settings = {
  async get<K extends keyof SettingsShape>(key: K): Promise<SettingsShape[K]> {
    const s = await getStore();
    const v = await s.get<SettingsShape[K]>(key);
    return v === undefined || v === null ? DEFAULTS[key] : v;
  },

  async set<K extends keyof SettingsShape>(key: K, value: SettingsShape[K]): Promise<void> {
    const s = await getStore();
    await s.set(key, value);
    await s.save();
  },

  async getAll(): Promise<SettingsShape> {
    const s = await getStore();
    const out: SettingsShape = { ...DEFAULTS, serviceConfigs: { ...DEFAULTS.serviceConfigs } };
    for (const k of Object.keys(DEFAULTS) as (keyof SettingsShape)[]) {
      const v = await s.get(k);
      if (v !== undefined && v !== null) (out[k] as unknown) = v;
    }
    return out;
  },

  async reset<K extends keyof SettingsShape>(key: K): Promise<void> {
    const s = await getStore();
    await s.delete(key);
    await s.save();
  },
};
