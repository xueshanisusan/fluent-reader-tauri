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

// The frozen daily-digest snapshot: the picked iids for a given local date.
// Regenerated when `date` no longer matches today. null = never generated.
export interface DigestSnapshot {
  date: string;
  iids: number[];
}

// Tunables for the digest selection algorithm.
export interface DigestConfig {
  // Total number of articles in the digest.
  size: number;
  // Minimum picked per group before weighted fill (coverage guarantee).
  base: number;
  // Max articles from any single source (diversity cap).
  perSource: number;
}

// Per-group weight for the digest (gid → weight). A missing group defaults to
// weight 1; weight <= 0 mutes the group entirely. Ungrouped sources share the
// sentinel key 0.
export type DigestWeights = Record<number, number>;

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
  dailyDigest: DigestSnapshot | null;
  digestWeights: DigestWeights;
  digestConfig: DigestConfig;
  translationConfig: TranslationConfig;
}

export const DIGEST_CONFIG_DEFAULT: DigestConfig = {
  size: 20,
  base: 2,
  perSource: 2,
};

// Which translation backend to use. Pluggable; only the local OpenAI-compatible
// provider (Ollama etc.) ships in the MVP.
export const enum TranslateProvider {
  LocalOpenAI = "localOpenai",
  // App-managed local runtime (Phase 2a): the app downloads a GGUF and runs a
  // llama.cpp server itself. The endpoint is resolved at runtime (random port),
  // so it is NOT persisted here — see model-bridge.ts::runtimeStart.
  ManagedLocal = "managedLocal",
}

export interface TranslationConfig {
  // Off by default (dark launch) — the Translate button only appears when on.
  enabled: boolean;
  provider: TranslateProvider;
  // Base URL of an OpenAI-compatible server, e.g. Ollama's http://localhost:11434/v1.
  endpoint: string;
  // Model name served by that endpoint, e.g. a local MiniCPM.
  model: string;
  // Free-text target language name, e.g. "简体中文" / "English". Empty = unset.
  targetLang: string;
}

export const TRANSLATION_CONFIG_DEFAULT: TranslationConfig = {
  enabled: false,
  provider: TranslateProvider.LocalOpenAI,
  endpoint: "http://localhost:11434/v1",
  model: "",
  targetLang: "",
};

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
  dailyDigest: null,
  digestWeights: {},
  digestConfig: DIGEST_CONFIG_DEFAULT,
  translationConfig: TRANSLATION_CONFIG_DEFAULT,
};

// Returns the trimmed Fever endpoint iff a Fever service is configured with a
// non-empty endpoint, else null. Pure (no store/IPC), so the refresh/background
// sync flows can cheaply decide whether to sync and it stays unit-testable.
export function isFeverActive(
  cfg: ServiceConfigs | null | undefined
): string | null {
  if (!cfg || cfg.type !== SyncService.Fever) return null;
  const endpoint = (cfg as FeverConfigs).endpoint?.trim();
  return endpoint ? endpoint : null;
}

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
    // Deep-clone the object-valued defaults so callers can't mutate DEFAULTS
    // through the returned object (scalars copy by value via the spread).
    const out: SettingsShape = {
      ...DEFAULTS,
      serviceConfigs: { ...DEFAULTS.serviceConfigs },
      digestWeights: { ...DEFAULTS.digestWeights },
      digestConfig: { ...DEFAULTS.digestConfig },
      translationConfig: { ...DEFAULTS.translationConfig },
    };
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
