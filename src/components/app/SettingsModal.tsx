import * as React from "react"
import {
    settings,
    ThemeSettings,
    SyncService,
    DIGEST_CONFIG_DEFAULT,
    TRANSLATION_CONFIG_DEFAULT,
    TranslateProvider,
    type SettingsShape,
    type FeverConfigs,
    type DigestConfig,
    type DigestWeights,
    type TranslationConfig,
    type TranslationTarget,
} from "../../scripts/settings-bridge"
import {
    model,
    describeModelError,
    type ModelStatus,
    type CuratedModel,
    type DownloadProgress,
    type BinaryDownloadProgress,
} from "../../scripts/model-bridge"
import { open as openFileDialog } from "@tauri-apps/plugin-dialog"
import type { Group } from "../../scripts/db-bridge"
import { UNGROUPED_BUCKET } from "../../scripts/digest"
import { service, describeSyncError } from "../../scripts/service-bridge"
import { setTheme } from "../../scripts/theme"
import { openExternal } from "../../scripts/shell-bridge"
import pkg from "../../../package.json"
import styles from "./SettingsModal.module.css"

export interface SettingsModalProps {
    open: boolean
    opmlBusy: boolean
    backfillBusy: boolean
    // Groups drive the per-group weight controls in the Digest tab.
    groups: Group[]
    onClose: () => void
    onChanged: (next: SettingsShape) => void
    onImportOpml: () => void
    onExportOpml: () => void
    onBackfillThumbs: () => void
    // Run a Fever source sync for the given (already-stored) endpoint. The app
    // owns this so it can refresh the sidebar/items afterward. Resolves to a
    // short status string to show in the Services tab.
    onSyncService: (endpoint: string, importGroups: boolean) => Promise<string>
}

type Draft = Pick<
    SettingsShape,
    "theme" | "fontSize" | "fontFamily" | "fetchInterval" | "notificationsEnabled"
>

type Tab =
    | "application"
    | "subscriptions"
    | "services"
    | "digest"
    | "translation"
    | "about"

// Local editing state for the Services (sync) tab. Password is never prefilled
// from storage — the api_key lives in the OS keychain, not the settings store.
type ServiceDraft = {
    endpoint: string
    username: string
    password: string
    fetchLimit: number
}

const FEVER_FETCH_LIMIT_DEFAULT = 250

const THEME_LABELS: Array<{ value: ThemeSettings; label: string }> = [
    { value: ThemeSettings.Default, label: "System" },
    { value: ThemeSettings.Light, label: "Light" },
    { value: ThemeSettings.Dark, label: "Dark" },
]

const PIVOT_ITEMS: Array<{ value: Tab; label: string }> = [
    { value: "application", label: "Application" },
    { value: "subscriptions", label: "Subscriptions" },
    { value: "services", label: "Services" },
    { value: "digest", label: "Digest" },
    { value: "translation", label: "Translation" },
    { value: "about", label: "About" },
]

const APP_VERSION = pkg.version
const REPO_URL = "https://github.com/yang991178/fluent-reader"

export function SettingsModal(props: SettingsModalProps): React.ReactElement | null {
    const {
        open,
        opmlBusy,
        backfillBusy,
        groups,
        onClose,
        onChanged,
        onImportOpml,
        onExportOpml,
        onBackfillThumbs,
        onSyncService,
    } = props
    const [draft, setDraft] = React.useState<Draft | null>(null)
    const [saving, setSaving] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)
    const [tab, setTab] = React.useState<Tab>("application")
    const [svc, setSvc] = React.useState<ServiceDraft>({
        endpoint: "",
        username: "",
        password: "",
        fetchLimit: FEVER_FETCH_LIMIT_DEFAULT,
    })
    const [svcConnected, setSvcConnected] = React.useState(false)
    const [svcBusy, setSvcBusy] = React.useState(false)
    const [svcStatus, setSvcStatus] = React.useState<string | null>(null)
    // Digest tab: tunables + per-group weights, persisted immediately on change
    // (they take effect on the next Regenerate / next day, since the digest is
    // frozen). Loaded from the store when the modal opens.
    const [digestCfg, setDigestCfg] = React.useState<DigestConfig>(
        DIGEST_CONFIG_DEFAULT
    )
    const [digestWeights, setDigestWeights] = React.useState<DigestWeights>({})
    // Translation tab: provider config, persisted immediately on change.
    const [translationCfg, setTranslationCfg] = React.useState<TranslationConfig>(
        TRANSLATION_CONFIG_DEFAULT
    )
    // Managed-local runtime (Phase 2b): installed inventory + catalog + the id
    // currently downloading (null = none), plus progress/error for that download.
    const [modelStatus, setModelStatus] = React.useState<ModelStatus | null>(null)
    const [modelCatalog, setModelCatalog] = React.useState<CuratedModel[]>([])
    const [downloadingId, setDownloadingId] = React.useState<string | null>(null)
    const [importing, setImporting] = React.useState(false)
    const [modelProgress, setModelProgress] =
        React.useState<DownloadProgress | null>(null)
    const [modelError, setModelError] = React.useState<string | null>(null)
    const [binaryDownloading, setBinaryDownloading] = React.useState(false)
    const [binaryProgress, setBinaryProgress] =
        React.useState<BinaryDownloadProgress | null>(null)
    const [binaryError, setBinaryError] = React.useState<string | null>(null)

    const refreshModelStatus = React.useCallback(() => {
        void model
            .status()
            .then(setModelStatus)
            .catch(e =>
                console.error("[Settings] model.status failed", e)
            )
    }, [])

    React.useEffect(() => {
        if (!open) {
            setDraft(null)
            setError(null)
            return
        }
        setTab("application")
        setSvcStatus(null)
        let cancelled = false
        void (async () => {
            try {
                const all = await settings.getAll()
                if (cancelled) return
                setDraft({
                    theme: all.theme,
                    fontSize: all.fontSize,
                    fontFamily: all.fontFamily,
                    fetchInterval: all.fetchInterval,
                    notificationsEnabled: all.notificationsEnabled,
                })
                const cfg = all.serviceConfigs
                if (cfg && cfg.type === SyncService.Fever) {
                    const fever = cfg as FeverConfigs
                    setSvc({
                        endpoint: fever.endpoint ?? "",
                        username: fever.username ?? "",
                        password: "",
                        fetchLimit:
                            fever.fetchLimit ?? FEVER_FETCH_LIMIT_DEFAULT,
                    })
                    setSvcConnected(true)
                } else {
                    setSvc({
                        endpoint: "",
                        username: "",
                        password: "",
                        fetchLimit: FEVER_FETCH_LIMIT_DEFAULT,
                    })
                    setSvcConnected(false)
                }
                setDigestCfg(all.digestConfig)
                setDigestWeights(all.digestWeights)
                setTranslationCfg(all.translationConfig)
            } catch (e) {
                if (cancelled) return
                setError("Load failed: " + String((e as Error)?.message ?? e))
            }
        })()
        return () => {
            cancelled = true
        }
    }, [open])

    const updateDigestCfg = React.useCallback((patch: Partial<DigestConfig>) => {
        setDigestCfg(prev => {
            const next = { ...prev, ...patch }
            void settings
                .set("digestConfig", next)
                .catch(e =>
                    console.error("[Settings] persist digestConfig failed", e)
                )
            return next
        })
    }, [])

    const updateDigestWeight = React.useCallback(
        (key: number, weight: number) => {
            setDigestWeights(prev => {
                const next = { ...prev, [key]: weight }
                void settings
                    .set("digestWeights", next)
                    .catch(e =>
                        console.error(
                            "[Settings] persist digestWeights failed",
                            e
                        )
                    )
                return next
            })
        },
        []
    )

    const updateTranslation = React.useCallback(
        (patch: Partial<TranslationConfig>) => {
            setTranslationCfg(prev => {
                const next = { ...prev, ...patch }
                void settings
                    .set("translationConfig", next)
                    .catch(e =>
                        console.error(
                            "[Settings] persist translationConfig failed",
                            e
                        )
                    )
                return next
            })
        },
        []
    )

    // Edit the target-language list; keep targetLang synced to the first entry
    // (full dedup/trim normalization runs on the next load — settings-bridge).
    const updateTargets = React.useCallback(
        (next: TranslationTarget[]) => {
            updateTranslation({
                targets: next,
                targetLang: next[0]?.lang?.trim() ?? "",
            })
        },
        [updateTranslation]
    )

    // Load installed-model status + catalog whenever the Translation tab shows
    // the managed provider, so the panel reflects reality (installed? running?).
    React.useEffect(() => {
        if (
            open &&
            tab === "translation" &&
            translationCfg.provider === TranslateProvider.ManagedLocal
        ) {
            refreshModelStatus()
            void model
                .catalog()
                .then(setModelCatalog)
                .catch(e => console.error("[Settings] model.catalog failed", e))
        }
    }, [open, tab, translationCfg.provider, refreshModelStatus])

    const onDownloadModel = React.useCallback(
        (id: string) => {
            if (downloadingId) return // single-flight (backend enforces too)
            setDownloadingId(id)
            setModelError(null)
            setModelProgress(null)
            void model
                .download(id, p => setModelProgress(p))
                .then(() => {
                    refreshModelStatus()
                })
                .catch(e =>
                    setModelError("Download failed: " + describeModelError(e))
                )
                .finally(() => {
                    setDownloadingId(null)
                    setModelProgress(null)
                })
        },
        [downloadingId, refreshModelStatus]
    )

    const onDownloadBinary = React.useCallback(() => {
        if (binaryDownloading) return // single-flight (backend enforces too)
        setBinaryDownloading(true)
        setBinaryError(null)
        setBinaryProgress(null)
        void model
            .downloadBinary(p => setBinaryProgress(p))
            .then(() => {
                refreshModelStatus()
            })
            .catch(e =>
                setBinaryError("Download failed: " + describeModelError(e))
            )
            .finally(() => {
                setBinaryDownloading(false)
                setBinaryProgress(null)
            })
    }, [binaryDownloading, refreshModelStatus])

    const onSetActive = React.useCallback(
        (id: string) => {
            setModelError(null)
            void model
                .setActive(id)
                .then(refreshModelStatus)
                .catch(e =>
                    setModelError("Couldn't switch model: " + describeModelError(e))
                )
        },
        [refreshModelStatus]
    )

    const onUninstall = React.useCallback(
        (m: { id: string; name: string }, running: boolean) => {
            const msg = running
                ? `Remove ${m.name}? It's currently in use — this stops translation until you pick another model. You'll need to download it again to use it.`
                : `Remove ${m.name}? You'll need to download it again to use it.`
            if (!window.confirm(msg)) return
            setModelError(null)
            void model
                .uninstall(m.id)
                .then(refreshModelStatus)
                .catch(e => {
                    setModelError("Uninstall failed: " + describeModelError(e))
                    refreshModelStatus()
                })
        },
        [refreshModelStatus]
    )

    const onImport = React.useCallback(() => {
        if (importing || downloadingId) return
        setModelError(null)
        void (async () => {
            try {
                const picked = await openFileDialog({
                    multiple: false,
                    directory: false,
                    filters: [{ name: "GGUF model", extensions: ["gguf"] }],
                })
                // null = user cancelled the dialog; do nothing.
                if (typeof picked !== "string") return
                setImporting(true)
                await model.import(picked)
                refreshModelStatus()
            } catch (e) {
                setModelError("Import failed: " + describeModelError(e))
            } finally {
                setImporting(false)
            }
        })()
    }, [importing, downloadingId, refreshModelStatus])

    const onServiceLogin = React.useCallback(async () => {
        const endpoint = svc.endpoint.trim()
        if (!endpoint || !svc.username || !svc.password) {
            setSvcStatus("Enter endpoint, username, and password.")
            return
        }
        setSvcBusy(true)
        setSvcStatus(null)
        try {
            const ok = await service.authenticate({
                endpoint,
                username: svc.username,
                password: svc.password,
            })
            if (ok) {
                const cfg: FeverConfigs = {
                    type: SyncService.Fever,
                    endpoint,
                    username: svc.username,
                    fetchLimit: svc.fetchLimit,
                    // First connection imports the server's groups on the next
                    // sync (cleared afterward); updating an existing connection
                    // leaves local grouping alone.
                    ...(svcConnected ? {} : { importGroups: true }),
                }
                await settings.set("serviceConfigs", cfg)
                setSvc(prev => ({ ...prev, endpoint, password: "" }))
                setSvcConnected(true)
                setSvcStatus(
                    svcConnected
                        ? "Credentials updated."
                        : "Connected. Click “Sync now” to import your feeds."
                )
            } else {
                setSvcStatus(
                    "Authentication failed — check the endpoint and credentials."
                )
            }
        } catch (e) {
            setSvcStatus("Error: " + describeSyncError(e))
        } finally {
            setSvcBusy(false)
        }
    }, [svc])

    const onServiceRemove = React.useCallback(async () => {
        setSvcBusy(true)
        setSvcStatus(null)
        try {
            await service.forget()
            await settings.set("serviceConfigs", { type: SyncService.None })
            setSvc({
                endpoint: "",
                username: "",
                password: "",
                fetchLimit: FEVER_FETCH_LIMIT_DEFAULT,
            })
            setSvcConnected(false)
            setSvcStatus("Service removed.")
        } catch (e) {
            setSvcStatus("Error: " + describeSyncError(e))
        } finally {
            setSvcBusy(false)
        }
    }, [])

    const onServiceSync = React.useCallback(
        async (forceImportGroups: boolean) => {
            const endpoint = svc.endpoint.trim()
            if (!endpoint) {
                setSvcStatus("Connect a service first.")
                return
            }
            setSvcBusy(true)
            setSvcStatus("Syncing…")
            try {
                const all = await settings.getAll()
                const cfg = all.serviceConfigs as FeverConfigs
                const importGroups =
                    forceImportGroups || Boolean(cfg.importGroups)
                // onSyncService owns persisting the advanced cursor and clearing
                // the one-time importGroups flag (single serviceConfigs write).
                const status = await onSyncService(endpoint, importGroups)
                setSvcStatus(status)
            } catch (e) {
                setSvcStatus("Sync failed: " + describeSyncError(e))
            } finally {
                setSvcBusy(false)
            }
        },
        [svc.endpoint, onSyncService]
    )

    React.useEffect(() => {
        if (!open) return
        function onKey(e: KeyboardEvent): void {
            if (e.key === "Escape") onClose()
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    }, [open, onClose])

    const onSave = React.useCallback(async () => {
        if (!draft) return
        setSaving(true)
        setError(null)
        try {
            const all = await settings.getAll()
            const next: SettingsShape = {
                ...all,
                theme: draft.theme,
                fontSize: draft.fontSize,
                fontFamily: draft.fontFamily,
                fetchInterval: draft.fetchInterval,
                notificationsEnabled: draft.notificationsEnabled,
            }
            if (all.theme !== draft.theme) await setTheme(draft.theme)
            if (all.fontSize !== draft.fontSize)
                await settings.set("fontSize", draft.fontSize)
            if (all.fontFamily !== draft.fontFamily)
                await settings.set("fontFamily", draft.fontFamily)
            if (all.fetchInterval !== draft.fetchInterval)
                await settings.set("fetchInterval", draft.fetchInterval)
            if (all.notificationsEnabled !== draft.notificationsEnabled)
                await settings.set(
                    "notificationsEnabled",
                    draft.notificationsEnabled
                )
            onChanged(next)
            onClose()
        } catch (e) {
            setError("Save failed: " + String((e as Error)?.message ?? e))
        } finally {
            setSaving(false)
        }
    }, [draft, onChanged, onClose])

    const openRepo = React.useCallback(() => {
        openExternal(REPO_URL).catch(e =>
            console.error("[SettingsModal] open repo failed", e)
        )
    }, [])

    if (!open) return null

    return (
        <div className={styles.overlay} onClick={onClose}>
            <div className={styles.drawer} onClick={e => e.stopPropagation()} role="dialog" aria-label="Settings">
                <div className={styles.header}>
                    <span className={styles.title}>Settings</span>
                    <button
                        className={`${styles.btn} ${styles.btnSecondary}`}
                        onClick={onClose}>
                        Close
                    </button>
                </div>
                <div className={styles.pivot} role="tablist">
                    {PIVOT_ITEMS.map(p => (
                        <button
                            key={p.value}
                            role="tab"
                            aria-selected={tab === p.value}
                            className={`${styles.pivotItem} ${tab === p.value ? styles.pivotItemActive : ""}`}
                            onClick={() => setTab(p.value)}>
                            {p.label}
                        </button>
                    ))}
                </div>
                <div className={styles.body}>
                    {draft === null && tab === "application" ? (
                        <div>Loading…</div>
                    ) : tab === "application" && draft !== null ? (
                        <div className={styles.section}>
                            <div className={styles.field}>
                                <label className={styles.label}>Theme</label>
                                <div className={styles.radioGroup}>
                                    {THEME_LABELS.map(opt => (
                                        <label
                                            key={opt.value}
                                            className={styles.radio}>
                                            <input
                                                type="radio"
                                                name="theme"
                                                checked={draft.theme === opt.value}
                                                onChange={() =>
                                                    setDraft({
                                                        ...draft,
                                                        theme: opt.value,
                                                    })
                                                }
                                            />
                                            {opt.label}
                                        </label>
                                    ))}
                                </div>
                            </div>

                            <div className={styles.field}>
                                <label className={styles.label}>
                                    Article font size
                                </label>
                                <input
                                    type="number"
                                    min={12}
                                    max={28}
                                    className={styles.numberInput}
                                    value={draft.fontSize}
                                    onChange={e =>
                                        setDraft({
                                            ...draft,
                                            fontSize: clamp(
                                                Number(e.target.value) || 16,
                                                12,
                                                28
                                            ),
                                        })
                                    }
                                />
                                <span className={styles.hint}>
                                    12–28 px. Applies to the article reading
                                    pane only.
                                </span>
                            </div>

                            <div className={styles.field}>
                                <label className={styles.label}>
                                    Article font family
                                </label>
                                <input
                                    type="text"
                                    className={styles.input}
                                    placeholder="system default"
                                    value={draft.fontFamily}
                                    onChange={e =>
                                        setDraft({
                                            ...draft,
                                            fontFamily: e.target.value,
                                        })
                                    }
                                />
                                <span className={styles.hint}>
                                    e.g. <code>Georgia, serif</code> or leave
                                    blank for system default.
                                </span>
                            </div>

                            <div className={styles.field}>
                                <label className={styles.radio}>
                                    <input
                                        type="checkbox"
                                        checked={draft.notificationsEnabled}
                                        onChange={e =>
                                            setDraft({
                                                ...draft,
                                                notificationsEnabled:
                                                    e.target.checked,
                                            })
                                        }
                                    />
                                    Show notifications for matching items
                                </label>
                                <span className={styles.hint}>
                                    Rules with a Notify action fire OS
                                    notifications when the app is not focused.
                                </span>
                            </div>

                            <div className={styles.field}>
                                <label className={styles.label}>
                                    Default refresh interval for new sources
                                </label>
                                <input
                                    type="number"
                                    min={0}
                                    max={1440}
                                    className={styles.numberInput}
                                    value={draft.fetchInterval}
                                    onChange={e =>
                                        setDraft({
                                            ...draft,
                                            fetchInterval: clamp(
                                                Number(e.target.value) || 0,
                                                0,
                                                1440
                                            ),
                                        })
                                    }
                                />
                                <span className={styles.hint}>
                                    Minutes between automatic refreshes when
                                    subscribing to a new feed. 0 = manual only.
                                </span>
                            </div>

                            {error && (
                                <div className={styles.errorMessage}>
                                    {error}
                                </div>
                            )}
                        </div>
                    ) : tab === "subscriptions" ? (
                        <div className={styles.section}>
                            <div className={styles.field}>
                                <label className={styles.label}>
                                    OPML
                                </label>
                                <div className={styles.opmlRow}>
                                    <button
                                        className={`${styles.btn} ${styles.btnSecondary}`}
                                        disabled={opmlBusy}
                                        onClick={onImportOpml}>
                                        Import OPML…
                                    </button>
                                    <button
                                        className={`${styles.btn} ${styles.btnSecondary}`}
                                        disabled={opmlBusy}
                                        onClick={onExportOpml}>
                                        Export OPML…
                                    </button>
                                </div>
                                <span className={styles.hint}>
                                    Import merges new feeds into your current
                                    list. Export saves all subscriptions to a
                                    file.
                                </span>
                            </div>
                            <div className={styles.field}>
                                <label className={styles.label}>
                                    Article images
                                </label>
                                <div className={styles.opmlRow}>
                                    <button
                                        className={`${styles.btn} ${styles.btnSecondary}`}
                                        disabled={backfillBusy}
                                        onClick={onBackfillThumbs}>
                                        {backfillBusy
                                            ? "Re-scanning…"
                                            : "Re-scan images for existing articles"}
                                    </button>
                                </div>
                                <span className={styles.hint}>
                                    Finds cover images in already-downloaded
                                    articles that were fetched before image
                                    extraction was available.
                                </span>
                            </div>
                        </div>
                    ) : tab === "services" ? (
                        <div className={styles.section}>
                            <div className={styles.field}>
                                <label className={styles.label}>
                                    Sync service
                                </label>
                                <span className={styles.hint}>
                                    Connect a Fever-compatible server (FreshRSS,
                                    Tiny Tiny RSS, Miniflux…) to sync your feeds
                                    and read/star state. Only Fever is supported
                                    so far.
                                </span>
                            </div>

                            {svcConnected && (
                                <div className={styles.field}>
                                    <span className={styles.connectedBadge}>
                                        Connected as {svc.username || "—"}
                                    </span>
                                </div>
                            )}

                            <div className={styles.field}>
                                <label className={styles.label}>
                                    Fever API endpoint
                                </label>
                                <input
                                    type="text"
                                    className={styles.input}
                                    placeholder="https://example.com/api/fever.php"
                                    value={svc.endpoint}
                                    disabled={svcBusy}
                                    onChange={e =>
                                        setSvc({
                                            ...svc,
                                            endpoint: e.target.value,
                                        })
                                    }
                                />
                                <span className={styles.hint}>
                                    The full Fever API URL. The app appends{" "}
                                    <code>?api</code> automatically.
                                </span>
                            </div>

                            <div className={styles.field}>
                                <label className={styles.label}>Username</label>
                                <input
                                    type="text"
                                    className={styles.input}
                                    autoComplete="username"
                                    value={svc.username}
                                    disabled={svcBusy}
                                    onChange={e =>
                                        setSvc({
                                            ...svc,
                                            username: e.target.value,
                                        })
                                    }
                                />
                            </div>

                            <div className={styles.field}>
                                <label className={styles.label}>Password</label>
                                <input
                                    type="password"
                                    className={styles.input}
                                    autoComplete="current-password"
                                    placeholder={
                                        svcConnected
                                            ? "•••••••• (re-enter to update)"
                                            : ""
                                    }
                                    value={svc.password}
                                    disabled={svcBusy}
                                    onChange={e =>
                                        setSvc({
                                            ...svc,
                                            password: e.target.value,
                                        })
                                    }
                                />
                                <span className={styles.hint}>
                                    Stored only as a hashed token in your OS
                                    keychain — never written to disk in plain
                                    text.
                                </span>
                            </div>

                            <div className={styles.field}>
                                <label className={styles.label}>
                                    Fetch limit
                                </label>
                                <input
                                    type="number"
                                    min={50}
                                    max={2000}
                                    className={styles.numberInput}
                                    value={svc.fetchLimit}
                                    disabled={svcBusy}
                                    onChange={e =>
                                        setSvc({
                                            ...svc,
                                            fetchLimit: clamp(
                                                Number(e.target.value) ||
                                                    FEVER_FETCH_LIMIT_DEFAULT,
                                                50,
                                                2000
                                            ),
                                        })
                                    }
                                />
                                <span className={styles.hint}>
                                    Max number of articles to pull per sync.
                                </span>
                            </div>

                            <div className={styles.opmlRow}>
                                <button
                                    className={styles.btn}
                                    onClick={onServiceLogin}
                                    disabled={svcBusy}>
                                    {svcBusy
                                        ? "Connecting…"
                                        : svcConnected
                                        ? "Update credentials"
                                        : "Login"}
                                </button>
                                {svcConnected && (
                                    <button
                                        className={`${styles.btn} ${styles.btnSecondary}`}
                                        onClick={() => onServiceSync(false)}
                                        disabled={svcBusy}>
                                        Sync now
                                    </button>
                                )}
                                {svcConnected && (
                                    <button
                                        className={`${styles.btn} ${styles.btnSecondary}`}
                                        onClick={() => onServiceSync(true)}
                                        disabled={svcBusy}>
                                        Import groups
                                    </button>
                                )}
                                {svcConnected && (
                                    <button
                                        className={`${styles.btn} ${styles.btnSecondary}`}
                                        onClick={onServiceRemove}
                                        disabled={svcBusy}>
                                        Remove service
                                    </button>
                                )}
                            </div>

                            {svcStatus && (
                                <div className={styles.hint}>{svcStatus}</div>
                            )}
                        </div>
                    ) : tab === "digest" ? (
                        <div className={styles.section}>
                            <div className={styles.field}>
                                <label className={styles.label}>
                                    Digest size
                                </label>
                                <input
                                    type="number"
                                    min={1}
                                    max={100}
                                    className={styles.numberInput}
                                    value={digestCfg.size}
                                    onChange={e =>
                                        updateDigestCfg({
                                            size: clamp(
                                                Number(e.target.value) || 20,
                                                1,
                                                100
                                            ),
                                        })
                                    }
                                />
                                <span className={styles.hint}>
                                    Total articles picked for the daily digest
                                    (1–100).
                                </span>
                            </div>

                            <div className={styles.field}>
                                <label className={styles.label}>
                                    Per-group minimum
                                </label>
                                <input
                                    type="number"
                                    min={0}
                                    max={20}
                                    className={styles.numberInput}
                                    value={digestCfg.base}
                                    onChange={e =>
                                        updateDigestCfg({
                                            base: clamp(
                                                Number(e.target.value) || 0,
                                                0,
                                                20
                                            ),
                                        })
                                    }
                                />
                                <span className={styles.hint}>
                                    Guaranteed picks per group before weighting,
                                    so no followed group is missed.
                                </span>
                            </div>

                            <div className={styles.field}>
                                <label className={styles.label}>
                                    Per-source cap
                                </label>
                                <input
                                    type="number"
                                    min={1}
                                    max={20}
                                    className={styles.numberInput}
                                    value={digestCfg.perSource}
                                    onChange={e =>
                                        updateDigestCfg({
                                            perSource: clamp(
                                                Number(e.target.value) || 1,
                                                1,
                                                20
                                            ),
                                        })
                                    }
                                />
                                <span className={styles.hint}>
                                    Max articles from any single feed, for
                                    diversity.
                                </span>
                            </div>

                            <div className={styles.field}>
                                <label className={styles.label}>
                                    Group weights
                                </label>
                                <span className={styles.hint}>
                                    Higher weight = a larger share of the digest.
                                    0 mutes a group. Changes apply on the next
                                    Regenerate.
                                </span>
                                <div className={styles.weightList}>
                                    {groups.map(g => (
                                        <div
                                            key={g.gid}
                                            className={styles.weightRow}>
                                            <span className={styles.weightName}>
                                                {g.name}
                                            </span>
                                            <input
                                                type="number"
                                                min={0}
                                                max={99}
                                                className={styles.numberInput}
                                                value={
                                                    digestWeights[g.gid] ?? 1
                                                }
                                                onChange={e =>
                                                    updateDigestWeight(
                                                        g.gid,
                                                        clamp(
                                                            Number(
                                                                e.target.value
                                                            ) || 0,
                                                            0,
                                                            99
                                                        )
                                                    )
                                                }
                                            />
                                        </div>
                                    ))}
                                    <div className={styles.weightRow}>
                                        <span className={styles.weightName}>
                                            Ungrouped
                                        </span>
                                        <input
                                            type="number"
                                            min={0}
                                            max={99}
                                            className={styles.numberInput}
                                            value={
                                                digestWeights[
                                                    UNGROUPED_BUCKET
                                                ] ?? 1
                                            }
                                            onChange={e =>
                                                updateDigestWeight(
                                                    UNGROUPED_BUCKET,
                                                    clamp(
                                                        Number(
                                                            e.target.value
                                                        ) || 0,
                                                        0,
                                                        99
                                                    )
                                                )
                                            }
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : tab === "translation" ? (
                        <div className={styles.section}>
                            <div className={styles.field}>
                                <label className={styles.radio}>
                                    <input
                                        type="checkbox"
                                        checked={translationCfg.enabled}
                                        onChange={e =>
                                            updateTranslation({
                                                enabled: e.target.checked,
                                            })
                                        }
                                    />
                                    Enable article translation
                                </label>
                                <span className={styles.hint}>
                                    Adds a Translate button to the article view.
                                    Nothing leaves your machine.
                                </span>
                            </div>

                            <div className={styles.field}>
                                <label className={styles.label}>Provider</label>
                                <select
                                    className={styles.input}
                                    value={translationCfg.provider}
                                    onChange={e =>
                                        updateTranslation({
                                            provider: e.target
                                                .value as TranslateProvider,
                                        })
                                    }>
                                    <option value={TranslateProvider.ManagedLocal}>
                                        Built-in model (app-managed)
                                    </option>
                                    <option value={TranslateProvider.LocalOpenAI}>
                                        Local OpenAI-compatible server
                                    </option>
                                </select>
                                <span className={styles.hint}>
                                    Built-in downloads and runs a small model for
                                    you. The other option points at a server you
                                    run yourself (e.g. Ollama).
                                </span>
                            </div>

                            {translationCfg.provider ===
                            TranslateProvider.ManagedLocal ? (
                                <ManagedModelPanel
                                    status={modelStatus}
                                    catalog={modelCatalog}
                                    downloadingId={downloadingId}
                                    importing={importing}
                                    progress={modelProgress}
                                    error={modelError}
                                    onDownload={onDownloadModel}
                                    onSetActive={onSetActive}
                                    onUninstall={onUninstall}
                                    onImport={onImport}
                                    binaryDownloading={binaryDownloading}
                                    binaryProgress={binaryProgress}
                                    binaryError={binaryError}
                                    onDownloadBinary={onDownloadBinary}
                                />
                            ) : (
                                <>
                                    <div className={styles.field}>
                                        <label className={styles.label}>
                                            Endpoint
                                        </label>
                                        <input
                                            type="text"
                                            className={styles.input}
                                            placeholder="http://localhost:11434/v1"
                                            value={translationCfg.endpoint}
                                            onChange={e =>
                                                updateTranslation({
                                                    endpoint: e.target.value,
                                                })
                                            }
                                        />
                                        <span className={styles.hint}>
                                            Base URL of the OpenAI-compatible API
                                            (Ollama defaults to{" "}
                                            <code>
                                                http://localhost:11434/v1
                                            </code>
                                            ).
                                        </span>
                                    </div>

                                    <div className={styles.field}>
                                        <label className={styles.label}>
                                            Model
                                        </label>
                                        <input
                                            type="text"
                                            className={styles.input}
                                            placeholder="e.g. a local translation model"
                                            value={translationCfg.model}
                                            onChange={e =>
                                                updateTranslation({
                                                    model: e.target.value,
                                                })
                                            }
                                        />
                                        <span className={styles.hint}>
                                            Model name served by the endpoint
                                            (Ollama: the pulled model&apos;s
                                            tag).
                                        </span>
                                    </div>
                                </>
                            )}

                            <div className={styles.field}>
                                <label className={styles.label}>
                                    Target languages
                                </label>
                                <div className={styles.modelList}>
                                    {translationCfg.targets.map((t, i) => (
                                        <div
                                            key={i}
                                            className={styles.targetRow}>
                                            <input
                                                type="text"
                                                className={styles.input}
                                                placeholder="e.g. 简体中文 / English"
                                                value={t.lang}
                                                onChange={e =>
                                                    updateTargets(
                                                        translationCfg.targets.map(
                                                            (u, j) =>
                                                                j === i
                                                                    ? {
                                                                          ...u,
                                                                          lang: e
                                                                              .target
                                                                              .value,
                                                                      }
                                                                    : u
                                                        )
                                                    )
                                                }
                                            />
                                            {translationCfg.provider ===
                                                TranslateProvider.ManagedLocal && (
                                                <select
                                                    className={styles.targetSelect}
                                                    value={t.modelId}
                                                    onChange={e =>
                                                        updateTargets(
                                                            translationCfg.targets.map(
                                                                (u, j) =>
                                                                    j === i
                                                                        ? {
                                                                              ...u,
                                                                              modelId:
                                                                                  e
                                                                                      .target
                                                                                      .value,
                                                                          }
                                                                        : u
                                                            )
                                                        )
                                                    }>
                                                    <option value="">
                                                        Default (active model)
                                                    </option>
                                                    {(
                                                        modelStatus?.installed ??
                                                        []
                                                    ).map(m => (
                                                        <option
                                                            key={m.id}
                                                            value={m.id}>
                                                            {m.name}
                                                        </option>
                                                    ))}
                                                </select>
                                            )}
                                            <button
                                                className={`${styles.btn} ${styles.btnSecondary}`}
                                                onClick={() =>
                                                    updateTargets(
                                                        translationCfg.targets.filter(
                                                            (_, j) => j !== i
                                                        )
                                                    )
                                                }
                                                aria-label="Remove target language">
                                                ✕
                                            </button>
                                        </div>
                                    ))}
                                </div>
                                <button
                                    className={`${styles.btn} ${styles.btnSecondary}`}
                                    onClick={() =>
                                        updateTargets([
                                            ...translationCfg.targets,
                                            { lang: "", modelId: "" },
                                        ])
                                    }>
                                    Add target language
                                </button>
                                <span className={styles.hint}>
                                    Articles translate into the first language by
                                    default; with two or more, a picker appears in
                                    the article toolbar.
                                    {translationCfg.provider ===
                                        TranslateProvider.ManagedLocal &&
                                        " Each language can use a specific installed model."}
                                </span>
                            </div>
                        </div>
                    ) : tab === "about" ? (
                        <div className={styles.section}>
                            <div className={styles.aboutTitle}>
                                Fluent Reader
                            </div>
                            <div className={styles.aboutVersion}>
                                Version {APP_VERSION} · Tauri build
                            </div>
                            <div className={styles.aboutTagline}>
                                A modern desktop RSS reader.
                            </div>
                            <button
                                className={styles.aboutLink}
                                onClick={openRepo}>
                                View project on GitHub
                            </button>
                        </div>
                    ) : null}
                </div>
                <div className={styles.footer}>
                    <button
                        className={`${styles.btn} ${styles.btnSecondary}`}
                        onClick={onClose}
                        disabled={saving}>
                        Cancel
                    </button>
                    <button
                        className={styles.btn}
                        onClick={onSave}
                        disabled={!draft || saving || tab !== "application"}>
                        {saving ? "Saving…" : "Save"}
                    </button>
                </div>
            </div>
        </div>
    )
}

interface ManagedModelPanelProps {
    status: ModelStatus | null
    catalog: CuratedModel[]
    downloadingId: string | null
    importing: boolean
    progress: DownloadProgress | null
    error: string | null
    onDownload: (id: string) => void
    onSetActive: (id: string) => void
    onUninstall: (m: { id: string; name: string }, running: boolean) => void
    onImport: () => void
    binaryDownloading: boolean
    binaryProgress: BinaryDownloadProgress | null
    binaryError: string | null
    onDownloadBinary: () => void
}

// The managed-local model manager: installed inventory (pick active / uninstall)
// plus a catalog of models to download and a button to import a user's own .gguf.
function ManagedModelPanel({
    status,
    catalog,
    downloadingId,
    importing,
    progress,
    error,
    onDownload,
    onSetActive,
    onUninstall,
    onImport,
    binaryDownloading,
    binaryProgress,
    binaryError,
    onDownloadBinary,
}: ManagedModelPanelProps): React.ReactElement {
    const installed = status?.installed ?? []
    const activeId = status?.activeId ?? null
    const runningId = status?.runningId ?? null
    // Catalog entries not yet installed — the "Add a model" choices.
    const available = catalog.filter(c => !installed.some(i => i.id === c.id))
    const binaryInstalled = status?.binaryInstalled ?? true // assume yes until status loads, to avoid a flash of the warning
    const binarySupported = status?.binarySupported ?? true

    return (
        <div className={styles.field}>
            <label className={styles.label}>Local model</label>

            {!binaryInstalled && (
                <div className={styles.modelRow}>
                    <span className={styles.modelAddInfo}>
                        <span className={styles.modelName}>
                            Translation engine (llama-server)
                        </span>
                        <span className={styles.hint}>
                            {binarySupported
                                ? "Required to run any local model. One-time download, ~15–20 MB."
                                : "No prebuilt engine for your OS/CPU yet — set LLAMA_SERVER_PATH to a binary you provide."}
                        </span>
                    </span>
                    {binarySupported &&
                        (binaryDownloading ? (
                            <span className={styles.hint}>
                                {binaryProgress
                                    ? `Downloading… ${downloadLabel(binaryProgress)}`
                                    : "Preparing…"}
                            </span>
                        ) : (
                            <button
                                className={`${styles.btn} ${styles.btnSecondary}`}
                                onClick={onDownloadBinary}
                                disabled={binaryDownloading}>
                                Download
                            </button>
                        ))}
                </div>
            )}
            {binaryError && (
                <span className={styles.hint} role="alert">
                    {binaryError}
                </span>
            )}

            {installed.length > 0 && (
                <div
                    className={styles.modelList}
                    role="radiogroup"
                    aria-label="Active translation model">
                    {installed.map(m => {
                        const isActive = activeId === m.id
                        const isRunning = runningId === m.id
                        // Switched active but the old model is still loaded: the
                        // change applies on the next translation, not right now.
                        const pending =
                            isActive && runningId !== null && runningId !== m.id
                        return (
                            <div key={m.id} className={styles.modelRow}>
                                <label className={styles.modelPick}>
                                    <input
                                        type="radio"
                                        name="active-model"
                                        checked={isActive}
                                        onChange={() => onSetActive(m.id)}
                                    />
                                    <span className={styles.modelName}>
                                        {m.name}
                                    </span>
                                </label>
                                <span className={styles.modelMeta}>
                                    {formatBytes(m.sizeBytes)}
                                    {isRunning && " · running"}
                                </span>
                                <button
                                    className={`${styles.btn} ${styles.btnSecondary}`}
                                    onClick={() =>
                                        onUninstall(
                                            { id: m.id, name: m.name },
                                            isRunning
                                        )
                                    }>
                                    Uninstall
                                </button>
                                {pending && (
                                    <span className={styles.hint}>
                                        Active · applies on next translation
                                    </span>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}

            <div className={styles.modelAdd}>
                <span className={styles.label}>Add a model</span>
                {available.map(c => {
                    const isDownloading = downloadingId === c.id
                    const isRecommended = c.id === status?.defaultModelId
                    return (
                        <div key={c.id} className={styles.modelRow}>
                            <div className={styles.modelAddInfo}>
                                <span className={styles.modelName}>
                                    {c.name}
                                    {isRecommended && (
                                        <span className={styles.modelBadge}>
                                            Recommended
                                        </span>
                                    )}
                                </span>
                                <span className={styles.hint}>
                                    {formatBytes(c.sizeBytes)} · {c.license}
                                </span>
                            </div>
                            {isDownloading ? (
                                <span className={styles.hint}>
                                    {progress
                                        ? `Downloading… ${downloadLabel(progress)}`
                                        : "Preparing…"}
                                </span>
                            ) : (
                                <button
                                    className={`${styles.btn} ${styles.btnSecondary}`}
                                    onClick={() => onDownload(c.id)}
                                    disabled={
                                        downloadingId !== null || importing
                                    }>
                                    Download
                                </button>
                            )}
                        </div>
                    )
                })}
                <div className={styles.modelRow}>
                    <span className={styles.modelAddInfo}>
                        <span className={styles.modelName}>
                            Import your own model
                        </span>
                        <span className={styles.hint}>
                            A .gguf file you already have (copied into the app).
                        </span>
                    </span>
                    {importing ? (
                        <span className={styles.hint}>
                            Importing… large files take a while
                        </span>
                    ) : (
                        <button
                            className={`${styles.btn} ${styles.btnSecondary}`}
                            onClick={onImport}
                            disabled={downloadingId !== null}>
                            Import .gguf…
                        </button>
                    )}
                </div>
            </div>

            <span className={styles.hint}>
                Models run locally via the llama-server binary in your app data
                folder&apos;s <code>bin/</code>. Nothing leaves your machine.
            </span>

            {error && (
                <span className={styles.hint} role="alert">
                    {error}
                </span>
            )}
        </div>
    )
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, Math.round(n)))
}

function formatBytes(n: number): string {
    if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`
    return `${Math.round(n / 1_048_576)} MB`
}

// Progress label: a percentage when the server reported a total, else raw MB.
function downloadLabel(p: {
    downloadedBytes: number
    totalBytes: number | null
    phase: string
}): string {
    if (p.phase === "verifying") return "verifying…"
    if (p.phase === "extracting") return "extracting…"
    if (p.totalBytes && p.totalBytes > 0) {
        return `${Math.floor((p.downloadedBytes / p.totalBytes) * 100)}%`
    }
    return formatBytes(p.downloadedBytes)
}
