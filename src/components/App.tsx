import * as React from "react"
import type { HostStyle } from "./article/iframe-bootstrap"
import { openExternal } from "../scripts/shell-bridge"
import {
    groups as groupsApi,
    sources as sourcesApi,
    items as itemsApi,
    type Group,
    type Source,
    type Item,
} from "../scripts/db-bridge"
import {
    refreshAll,
    isRefreshSuccess,
    type RefreshResult,
} from "../scripts/feeds"
import { feeds as feedsApi, type DiscoveredFeed } from "../scripts/feeds-bridge"
import {
    service as serviceApi,
    type MarkKind,
} from "../scripts/service-bridge"
import { startAutoRefresh } from "../scripts/auto-refresh"
import { NavBar } from "./app/NavBar"
import { SearchBar } from "./app/SearchBar"
import { SubscribeModal } from "./app/SubscribeModal"
import { ItemListHeader } from "./app/ItemListHeader"
import { ItemList } from "./app/ItemList"
import { ItemContextMenu } from "./app/ItemContextMenu"
import { ArticleOverlay } from "./app/ArticleOverlay"
import { Sidebar } from "./app/Sidebar"
import { RulesModal } from "./app/RulesModal"
import { SettingsModal } from "./app/SettingsModal"
import { useArticleList } from "./app/useArticleList"
import { useDigest } from "./app/useDigest"
import { DigestView } from "./app/DigestView"
import {
    settings,
    isFeverActive,
    ViewType,
    ViewConfigs,
    SyncService,
    type SettingsShape,
    type ServiceConfigs,
    type FeverConfigs,
} from "../scripts/settings-bridge"
import { useLogStore } from "../scripts/log-store"
import {
    getResolvedTheme,
    onResolvedThemeChange,
    type Resolved,
} from "../scripts/theme"
import layout from "./app/layout.module.css"

function formatRefreshSummary(results: RefreshResult[]): string {
    if (results.length === 0) return "no feeds to refresh"
    let updated = 0
    let notModified = 0
    let inserted = 0
    let failed = 0
    let firstError: string | null = null
    for (const r of results) {
        if (isRefreshSuccess(r)) {
            if (r.outcome.kind === "updated") {
                updated += 1
                inserted += r.outcome.inserted
            } else {
                notModified += 1
            }
        } else {
            failed += 1
            if (!firstError) {
                firstError = `${r.error.kind}: ${r.error.message}`
            }
        }
    }
    const parts = [
        `${results.length} feed${results.length === 1 ? "" : "s"}`,
        `${inserted} new`,
    ]
    if (notModified) parts.push(`${notModified} 304`)
    if (failed) parts.push(`${failed} failed`)
    let out = parts.join(" · ")
    if (firstError) out += ` — ${firstError}`
    return out
}

// What the sidebar has selected: everything, one source, a whole group, or the
// daily digest. A group resolves (in the backend) to all its member sources'
// items; the digest is a separate frozen feed (see useDigest).
type Selection =
    | { kind: "all" }
    | { kind: "source"; sid: number }
    | { kind: "group"; gid: number }
    | { kind: "digest" }

export function App(): React.ReactElement {
    const [sources, setSources] = React.useState<Source[]>([])
    const [groups, setGroups] = React.useState<Group[]>([])
    const [expandedGroups, setExpandedGroups] = React.useState<
        ReadonlySet<number>
    >(() => new Set())
    const [selection, setSelection] = React.useState<Selection>({ kind: "all" })
    const selectedSourceId =
        selection.kind === "source" ? selection.sid : null
    const selectedGroupId = selection.kind === "group" ? selection.gid : null
    const digestActive = selection.kind === "digest"
    const [searchInput, setSearchInput] = React.useState("")
    const [searchQuery, setSearchQuery] = React.useState("")

    React.useEffect(() => {
        const t = setTimeout(() => setSearchQuery(searchInput), 200)
        return () => clearTimeout(t)
    }, [searchInput])

    const [appSettings, setAppSettings] = React.useState<SettingsShape | null>(
        null
    )

    // Push a local read/star change to the sync service (Fever), best-effort. A
    // null serviceRef or non-Fever service is a no-op. Fire-and-forget: the UI
    // already updated locally and the next sync reconciles — this mirrors the
    // original's real-time markItem. Config is read fresh so a just-connected
    // service is picked up without an app reload.
    const pushItemMark = React.useCallback((item: Item, kind: MarkKind) => {
        if (!item.serviceRef) return
        void (async () => {
            try {
                const cfg = await settings.get("serviceConfigs")
                if (cfg.type !== SyncService.Fever) return
                const endpoint = (cfg as FeverConfigs).endpoint
                if (endpoint) await serviceApi.mark(endpoint, item.serviceRef!, kind)
            } catch (e) {
                console.error("[App] push item mark failed", e)
            }
        })()
    }, [])

    // Mark an entire source read on the service (the markAllRead optimization).
    const pushSourceRead = React.useCallback(
        (sourceId: number, beforeMs: number) => {
            const src = sources.find(s => s.sid === sourceId)
            if (!src?.serviceRef) return
            void (async () => {
                try {
                    const cfg = await settings.get("serviceConfigs")
                    if (cfg.type !== SyncService.Fever) return
                    const endpoint = (cfg as FeverConfigs).endpoint
                    if (endpoint)
                        await serviceApi.markFeedRead(
                            endpoint,
                            src.serviceRef!,
                            beforeMs
                        )
                } catch (e) {
                    console.error("[App] push source read failed", e)
                }
            })()
        },
        [sources]
    )

    const list = useArticleList({
        sourceId: selectedSourceId,
        groupId: selectedGroupId,
        searchQuery,
        // All views use the full-width feed + article overlay, so nothing is
        // auto-opened — the overlay appears only when the user clicks an item.
        autoSelectFirst: false,
        pushItemMark,
        pushSourceRead,
    })
    const {
        items,
        listLoading,
        listError,
        filter,
        selectedItem,
        unreadCounts,
        setFilter,
        setSelectedItem,
        onOpenItem,
        loadItems,
        reloadUnreadCounts,
        onToggleRead,
        onToggleStar,
        onToggleReadItem,
        onToggleStarItem,
        onSetHiddenItem,
        onMarkAllRead,
        onSelectNeighbor,
        onOpenSelectedLink,
    } = list

    // The daily digest: a frozen, curated pick from unread, its own feed. Only
    // builds/loads while its sidebar entry is active. Reading in it refreshes
    // the sidebar unread badges via reloadUnreadCounts.
    const digest = useDigest({
        active: digestActive,
        sources,
        pushItemMark,
        onAfterMutate: reloadUnreadCounts,
    })

    // Right-click context menu for a feed item (null = closed).
    const [itemMenu, setItemMenu] = React.useState<{
        item: Item
        x: number
        y: number
    } | null>(null)

    const [refreshInFlight, setRefreshInFlight] = React.useState(false)
    const [refreshStatus, setRefreshStatus] = React.useState<string | null>(null)
    const [subscribeUrl, setSubscribeUrl] = React.useState("")
    const [subscribeInFlight, setSubscribeInFlight] = React.useState(false)
    const [subscribeStatus, setSubscribeStatus] = React.useState<string | null>(
        null
    )
    const [picker, setPicker] = React.useState<DiscoveredFeed[] | null>(null)
    const [subscribeOpen, setSubscribeOpen] = React.useState(false)
    const [remount, setRemount] = React.useState(0)
    const [opmlBusy, setOpmlBusy] = React.useState(false)
    const [backfillBusy, setBackfillBusy] = React.useState(false)
    const [settingsOpen, setSettingsOpen] = React.useState(false)
    const [rulesModalSid, setRulesModalSid] = React.useState<number | null>(null)
    const [sidebarVisible, setSidebarVisible] = React.useState(true)
    const [searchBarVisible, setSearchBarVisible] = React.useState(false)
    const [resolvedTheme, setResolvedTheme] = React.useState<Resolved>(() =>
        getResolvedTheme()
    )
    const logs = useLogStore()
    // startAutoRefresh runs in an effect that should not re-subscribe on every
    // sources change. We keep a ref mirroring `sources` so the auto-tick log
    // append can resolve names by sid without putting `sources` in the deps.
    const sourcesRef = React.useRef<Source[]>([])
    React.useEffect(() => {
        sourcesRef.current = sources
    }, [sources])

    React.useEffect(() => {
        const unsub = onResolvedThemeChange(setResolvedTheme)
        // Sync once in case theme was applied between the initial state read
        // and effect mount (applyStoredTheme runs async at startup).
        setResolvedTheme(getResolvedTheme())
        return unsub
    }, [])

    // Stable identity for the iframe's host style props. Without this, the
    // object literal would change identity on every App re-render, defeating
    // any downstream React.memo and making `useEffect([hostStyle])` patterns
    // unsafe to add later. The iframe's srcdoc useMemo reads scalar fields,
    // so it doesn't care — but the identity stability is cheap insurance.
    const hostStyle = React.useMemo<HostStyle>(
        () => ({
            fontSize: appSettings?.fontSize ?? 16,
            fontFamily: appSettings?.fontFamily ?? "",
            theme: resolvedTheme,
        }),
        [appSettings?.fontSize, appSettings?.fontFamily, resolvedTheme]
    )

    // sid → {name, iconUrl} for the card meta line (favicon + source name).
    const sourceMeta = React.useMemo(
        () =>
            new Map(
                sources.map(
                    s => [s.sid, { name: s.name, iconUrl: s.iconUrl }] as const
                )
            ),
        [sources]
    )

    const fileInputRef = React.useRef<HTMLInputElement | null>(null)
    const cancelledRef = React.useRef(false)
    React.useEffect(() => {
        cancelledRef.current = false
        return () => {
            cancelledRef.current = true
        }
    }, [])

    // Service sync woven into the refresh flows. serviceSyncInFlightRef skips an
    // overlapping sync so a slow sync + a Refresh click (or a background tick)
    // don't pile up. syncServiceRef holds the latest syncServiceIfActive so
    // onRefresh and the background timer can invoke it without a declaration-
    // order cycle (it's defined after onSyncService, below) and without
    // re-subscribing the timer whenever that callback's identity changes.
    const serviceSyncInFlightRef = React.useRef(false)
    const syncServiceRef = React.useRef<() => Promise<void>>(async () => {})

    const loadSourcesAndGroups = React.useCallback(async () => {
        try {
            const [srcList, grpList] = await Promise.all([
                sourcesApi.list(),
                groupsApi.list(),
            ])
            if (cancelledRef.current) return
            setSources(srcList)
            setGroups(grpList)
            setExpandedGroups(
                new Set(grpList.filter(g => g.expanded).map(g => g.gid))
            )
        } catch (e) {
            console.error("[App] load sources/groups failed", e)
        }
    }, [])

    React.useEffect(() => {
        loadSourcesAndGroups()
    }, [loadSourcesAndGroups])

    React.useEffect(() => {
        let cancelled = false
        void (async () => {
            try {
                const all = await settings.getAll()
                if (!cancelled) setAppSettings(all)
            } catch (e) {
                console.error("[App] load settings failed", e)
            }
        })()
        return () => {
            cancelled = true
        }
    }, [])

    React.useEffect(() => {
        const stop = startAutoRefresh({
            onTick: results => {
                if (cancelledRef.current) return
                const inserted = results.reduce(
                    (n, r) =>
                        n +
                        (isRefreshSuccess(r) && r.outcome.kind === "updated"
                            ? r.outcome.inserted
                            : 0),
                    0
                )
                setRefreshStatus(
                    `auto: ${results.length} checked · ${inserted} new`
                )
                const names = new Map(
                    sourcesRef.current.map(s => [s.sid, s.name])
                )
                logs.appendRefreshResults(results, names, "auto")
                void loadItems()
            },
            onError: e => {
                console.error("[App] auto-refresh tick failed", e)
            },
        })
        return stop
    }, [loadItems, logs])

    const finalizeSubscribe = React.useCallback(
        async (feed: DiscoveredFeed) => {
            const created = await sourcesApi.create({
                url: feed.url,
                name: feed.title?.trim() || feed.url,
                fetchFrequency: appSettings?.fetchInterval ?? 0,
            })
            const outcome = await feedsApi.ingest(created.sid)
            if (cancelledRef.current) return
            const summary =
                outcome.kind === "updated"
                    ? `subscribed · ${outcome.inserted} new`
                    : `subscribed · not modified`
            // Auto-close the modal on success; surface the result on the
            // NavBar status line since closing discards the modal's own status.
            setRefreshStatus(`${created.name} — ${summary}`)
            setSubscribeStatus(null)
            setSubscribeUrl("")
            setPicker(null)
            setSubscribeOpen(false)
            await loadSourcesAndGroups()
            await loadItems()
        },
        [loadItems, loadSourcesAndGroups, appSettings]
    )

    const onSubscribe = React.useCallback(async () => {
        const url = subscribeUrl.trim()
        if (!url || subscribeInFlight) return
        setSubscribeInFlight(true)
        setSubscribeStatus("discovering…")
        setPicker(null)
        try {
            const found = await feedsApi.discover(url)
            if (cancelledRef.current) return
            if (found.length === 1) {
                await finalizeSubscribe(found[0])
            } else {
                setPicker(found)
                setSubscribeStatus(`${found.length} feeds found — pick one`)
            }
        } catch (e) {
            if (cancelledRef.current) return
            const err = e as { kind?: string; message?: string } | Error
            const kind = (err as { kind?: string }).kind
            const message = (err as { message?: string }).message ?? String(e)
            setSubscribeStatus(
                kind
                    ? `subscribe failed (${kind}): ${message}`
                    : `subscribe failed: ${message}`
            )
        } finally {
            if (!cancelledRef.current) setSubscribeInFlight(false)
        }
    }, [subscribeUrl, subscribeInFlight, finalizeSubscribe])

    const onPickFeed = React.useCallback(
        async (feed: DiscoveredFeed) => {
            setSubscribeInFlight(true)
            setSubscribeStatus("subscribing…")
            try {
                await finalizeSubscribe(feed)
            } catch (e) {
                if (cancelledRef.current) return
                setSubscribeStatus(
                    "subscribe failed: " + String((e as Error)?.message ?? e)
                )
            } finally {
                if (!cancelledRef.current) setSubscribeInFlight(false)
            }
        },
        [finalizeSubscribe]
    )

    const onCancelPick = React.useCallback(() => {
        setPicker(null)
        setSubscribeStatus(null)
    }, [])

    const onCloseSubscribe = React.useCallback(() => {
        setSubscribeOpen(false)
        setPicker(null)
        setSubscribeStatus(null)
        setSubscribeUrl("")
    }, [])

    const onRefresh = React.useCallback(async () => {
        if (refreshInFlight) return
        setRefreshInFlight(true)
        setRefreshStatus("refreshing…")
        try {
            // Sync the remote service first (if one is active) — it may
            // add/adopt sources — then RSS-fetch only the local-only sources.
            // Remote sources pull their items through the service, so they're
            // excluded from refreshAll to avoid a double fetch. Read the source
            // list fresh AFTER the sync so newly adopted sources are honored and
            // a delete/rename mid-refresh can't blank a log row's name.
            await syncServiceRef.current()
            if (cancelledRef.current) return
            const fresh = await sourcesApi.list()
            if (cancelledRef.current) return
            const names = new Map(fresh.map(s => [s.sid, s.name]))
            const sids = fresh
                .filter(s => s.serviceRef == null)
                .map(s => s.sid)
            if (sids.length > 0) {
                const results = await refreshAll(sids)
                if (cancelledRef.current) return
                setRefreshStatus(formatRefreshSummary(results))
                logs.appendRefreshResults(results, names, "manual")
            }
            // else: no local feeds — keep the service-sync status line.
            await loadItems()
        } catch (e) {
            if (cancelledRef.current) return
            setRefreshStatus(
                "refresh failed: " + String((e as Error)?.message ?? e)
            )
        } finally {
            if (!cancelledRef.current) setRefreshInFlight(false)
        }
    }, [refreshInFlight, loadItems, logs])

    const onSelectSource = React.useCallback((sid: number | null) => {
        setSelection(sid === null ? { kind: "all" } : { kind: "source", sid })
    }, [])

    const onSelectGroup = React.useCallback((gid: number) => {
        setSelection({ kind: "group", gid })
    }, [])

    const onSelectDigest = React.useCallback(() => {
        setSelection({ kind: "digest" })
    }, [])

    const onChangeViewMode = React.useCallback(
        (v: ViewType) => {
            setAppSettings(prev => (prev ? { ...prev, view: v } : prev))
            settings
                .set("view", v)
                .catch(e => console.error("[App] persist view failed", e))
        },
        []
    )

    // Toggle a List-view display flag (cover/snippet/fade). XOR the bit, update
    // state for a live re-render, and persist. Mirrors onChangeViewMode's
    // set-state-then-persist shape (persist outside the updater).
    const onToggleViewConfig = React.useCallback(
        (bit: ViewConfigs) => {
            const cur = appSettings?.listViewConfigs ?? ViewConfigs.ShowCover
            const next = cur ^ bit
            setAppSettings(prev =>
                prev ? { ...prev, listViewConfigs: next } : prev
            )
            settings
                .set("listViewConfigs", next)
                .catch(e =>
                    console.error("[App] persist listViewConfigs failed", e)
                )
        },
        [appSettings?.listViewConfigs]
    )

    const onToggleGroup = React.useCallback(
        async (gid: number, expanded: boolean) => {
            setExpandedGroups(prev => {
                const next = new Set(prev)
                if (expanded) next.add(gid)
                else next.delete(gid)
                return next
            })
            try {
                await groupsApi.setExpanded(gid, expanded)
            } catch (e) {
                console.error("[App] setExpanded failed", e)
            }
        },
        []
    )

    const onRenameSource = React.useCallback(
        async (sid: number, name: string) => {
            const prev = sources.find(s => s.sid === sid)
            if (!prev || prev.name === name) return
            setSources(p => p.map(s => (s.sid === sid ? { ...s, name } : s)))
            try {
                await sourcesApi.rename(sid, name)
            } catch (e) {
                console.error("[App] rename source failed", e)
                setSources(p =>
                    p.map(s => (s.sid === sid ? { ...s, name: prev.name } : s))
                )
                window.alert(
                    "Rename failed: " + String((e as Error)?.message ?? e)
                )
            }
        },
        [sources]
    )

    const onDeleteSource = React.useCallback(
        async (s: Source) => {
            const ok = window.confirm(
                `Delete "${s.name}"?\nAll items from this feed will also be removed.`
            )
            if (!ok) return
            try {
                await sourcesApi.delete(s.sid)
                if (cancelledRef.current) return
                setSources(prev => prev.filter(x => x.sid !== s.sid))
                if (selection.kind === "source" && selection.sid === s.sid)
                    setSelection({ kind: "all" })
                await loadItems()
                await reloadUnreadCounts()
            } catch (e) {
                console.error("[App] delete source failed", e)
                window.alert(
                    "Delete failed: " + String((e as Error)?.message ?? e)
                )
            }
        },
        [selection, loadItems, reloadUnreadCounts]
    )

    const onImportOpml = React.useCallback(() => {
        fileInputRef.current?.click()
    }, [])

    const onOpmlFileChosen = React.useCallback(
        async (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0]
            e.target.value = ""
            if (!file) return
            setOpmlBusy(true)
            setRefreshStatus("importing OPML…")
            try {
                const xml = await file.text()
                const summary = await feedsApi.importOpml(xml)
                if (cancelledRef.current) return
                setRefreshStatus(
                    `OPML: ${summary.sourcesAdded} added · ${summary.sourcesSkipped} skipped · ${summary.groupsCreated} new group${
                        summary.groupsCreated === 1 ? "" : "s"
                    }`
                )
                logs.appendOpmlImport(summary)
                await loadSourcesAndGroups()
                await loadItems()
            } catch (err) {
                if (cancelledRef.current) return
                const er = err as { kind?: string; message?: string } | Error
                const kind = (er as { kind?: string }).kind
                const message = (er as { message?: string }).message ?? String(err)
                setRefreshStatus(
                    kind
                        ? `OPML import failed (${kind}): ${message}`
                        : `OPML import failed: ${message}`
                )
                logs.appendOpmlImportError({ kind, message })
            } finally {
                if (!cancelledRef.current) setOpmlBusy(false)
            }
        },
        [loadItems, loadSourcesAndGroups, logs]
    )

    const onExportOpml = React.useCallback(async () => {
        setOpmlBusy(true)
        setRefreshStatus("exporting OPML…")
        try {
            const xml = await feedsApi.exportOpml()
            if (cancelledRef.current) return
            const blob = new Blob([xml], { type: "application/xml" })
            const url = URL.createObjectURL(blob)
            const a = document.createElement("a")
            a.href = url
            a.download = "subscriptions.opml"
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            // Revoke after a tick so the browser has time to start the download.
            window.setTimeout(() => URL.revokeObjectURL(url), 1000)
            setRefreshStatus(`OPML exported · ${xml.length} bytes`)
            logs.appendOpmlExportSuccess(xml.length)
        } catch (err) {
            if (cancelledRef.current) return
            const er = err as { kind?: string; message?: string } | Error
            const kind = (er as { kind?: string }).kind
            const message = (er as { message?: string }).message ?? String(err)
            setRefreshStatus(
                kind
                    ? `OPML export failed (${kind}): ${message}`
                    : `OPML export failed: ${message}`
            )
            logs.appendOpmlExportError({ kind, message })
        } finally {
            if (!cancelledRef.current) setOpmlBusy(false)
        }
    }, [logs])

    const onBackfillThumbs = React.useCallback(async () => {
        setBackfillBusy(true)
        setRefreshStatus("re-scanning images…")
        try {
            const summary = await itemsApi.backfillThumbs()
            if (cancelledRef.current) return
            setRefreshStatus(
                `Images: ${summary.updated} added · ${summary.scanned} scanned`
            )
            await loadItems()
        } catch (err) {
            if (cancelledRef.current) return
            const er = err as { kind?: string; message?: string } | Error
            const kind = (er as { kind?: string }).kind
            const message = (er as { message?: string }).message ?? String(err)
            setRefreshStatus(
                kind
                    ? `Image re-scan failed (${kind}): ${message}`
                    : `Image re-scan failed: ${message}`
            )
        } finally {
            if (!cancelledRef.current) setBackfillBusy(false)
        }
    }, [loadItems])

    const onSyncService = React.useCallback(
        async (endpoint: string, importGroups: boolean): Promise<string> => {
            setRefreshStatus("syncing service…")
            try {
                // Read the stored cursor + fetch limit; pass them through and
                // persist the advanced cursor the backend returns so the next
                // sync is incremental. Clearing importGroups (a one-time flag) is
                // owned here too, in the same write, to avoid clobbering the cursor.
                const cfg = (await settings.get(
                    "serviceConfigs"
                )) as FeverConfigs
                const res = await serviceApi.sync(
                    endpoint,
                    importGroups,
                    cfg.fetchLimit ?? 250,
                    cfg.lastId ?? 0,
                    cfg.useInt32 ?? false
                )
                const next: FeverConfigs = {
                    ...cfg,
                    lastId: res.lastId,
                    useInt32: res.useInt32,
                }
                if (importGroups) delete next.importGroups
                await settings.set("serviceConfigs", next)
                // Item pull + reconciliation changed sources and items — refresh.
                await loadSourcesAndGroups()
                await loadItems()
                const groupedNote =
                    res.grouped > 0 ? ` · ${res.grouped} grouped` : ""
                const reconciledNote =
                    res.reconciled > 0 ? ` · ${res.reconciled} synced` : ""
                const status = `Synced · ${res.added} added · ${res.adopted} adopted · ${res.removed} removed · ${res.fetched} articles${reconciledNote}${groupedNote}`
                if (!cancelledRef.current) setRefreshStatus(status)
                return status
            } catch (e) {
                // Reset the status bar so it doesn't sit on "syncing service…".
                // The Settings modal surfaces the detailed failure; rethrow for it.
                if (!cancelledRef.current) setRefreshStatus("sync failed")
                throw e
            }
        },
        [loadSourcesAndGroups, loadItems]
    )

    // Sync the active Fever service if one is configured, guarded so overlapping
    // calls (a background tick landing during a manual Refresh) don't pile up.
    // Never rejects: callers (onRefresh, the background timer) treat sync as
    // best-effort. onSyncService stays unguarded so the Settings modal's
    // importGroups path is never skipped by this guard.
    const syncServiceIfActive = React.useCallback(async () => {
        if (serviceSyncInFlightRef.current) return
        let cfg: ServiceConfigs
        try {
            cfg = await settings.get("serviceConfigs")
        } catch {
            return
        }
        const endpoint = isFeverActive(cfg)
        if (!endpoint) return
        serviceSyncInFlightRef.current = true
        try {
            await onSyncService(endpoint, false)
        } catch (e) {
            console.error("[App] auto service sync failed", e)
        } finally {
            serviceSyncInFlightRef.current = false
        }
    }, [onSyncService])

    // Keep the ref pointing at the latest callback so onRefresh and the
    // background timer can call it without depending on its identity.
    React.useEffect(() => {
        syncServiceRef.current = syncServiceIfActive
    }, [syncServiceIfActive])

    // Periodic background service sync, cadence = the RSS fetch interval. Own
    // timer (not startAutoRefresh's) so switching source/filter — which changes
    // loadItems' identity — never resets it. Paused while the window is hidden.
    React.useEffect(() => {
        const min = appSettings?.fetchInterval ?? 0
        if (min <= 0) return
        const h = window.setInterval(() => {
            if (typeof document !== "undefined" && document.hidden) return
            void syncServiceRef.current()
        }, min * 60_000)
        return () => window.clearInterval(h)
    }, [appSettings?.fetchInterval])

    const onLink = React.useCallback((url: string) => {
        openExternal(url).catch(err => {
            console.error("[App] openExternal failed", err)
            window.alert(
                "Open link failed: " + String((err as Error)?.message ?? err)
            )
        })
    }, [])

    // Clipboard write can reject in the webview (focus / secure-context), so
    // never let it throw unhandled. No clipboard plugin is installed; the
    // webview's navigator.clipboard is sufficient for these short strings.
    const copyText = React.useCallback((text: string) => {
        navigator.clipboard?.writeText(text).catch(err => {
            console.error("[App] clipboard write failed", err)
        })
    }, [])

    const handleShortcut = React.useCallback(
        (key: string): boolean => {
            // The list shortcuts act on the article-list feed; in the digest
            // view that feed is in the background, so ignore them to avoid
            // mutating the wrong list. (Esc/close still work via the overlay.)
            if (digestActive) return false
            switch (key) {
                case "j":
                    onSelectNeighbor(1)
                    return true
                case "k":
                    onSelectNeighbor(-1)
                    return true
                case "m":
                    void onToggleRead()
                    return true
                case "s":
                    void onToggleStar()
                    return true
                case "r":
                    void onRefresh()
                    return true
                case "o":
                    onOpenSelectedLink()
                    return true
            }
            return false
        },
        [
            digestActive,
            onSelectNeighbor,
            onToggleRead,
            onToggleStar,
            onRefresh,
            onOpenSelectedLink,
        ]
    )

    const onArticleKey = React.useCallback(
        (key: string) => {
            handleShortcut(key)
        },
        [handleShortcut]
    )

    React.useEffect(() => {
        function onKey(e: KeyboardEvent): void {
            if (e.ctrlKey || e.metaKey || e.altKey) return
            const tgt = e.target as HTMLElement | null
            if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA"))
                return
            if (handleShortcut(e.key)) e.preventDefault()
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    }, [handleShortcut])

    const onCtxMenu = React.useCallback(
        (d: {
            x: number
            y: number
            text: string | null
            href: string | null
        }) => {
            console.log("[App] ctxmenu", d)
        },
        []
    )

    // In the digest view the article-list feed is in the background, so the
    // NavBar reflects the digest's own progress and its mark-all-read is a
    // no-op (it would otherwise mark the background feed).
    const hasUnread = digestActive
        ? digest.remaining > 0
        : !!items && items.some(i => !i.hasRead)
    const onMarkAllReadActive = digestActive ? async () => {} : onMarkAllRead

    return (
        <div className={layout.app}>
            <NavBar
                refreshInFlight={refreshInFlight}
                refreshStatus={refreshStatus}
                hasUnread={hasUnread}
                logEntries={logs.entries}
                onToggleSidebar={() => setSidebarVisible(v => !v)}
                onToggleSearch={() => {
                    setSearchBarVisible(v => {
                        const next = !v
                        if (!next) setSearchInput("")
                        return next
                    })
                }}
                onMarkAllRead={onMarkAllReadActive}
                onRefresh={onRefresh}
                onOpenSettings={() => setSettingsOpen(true)}
                onJumpToSource={onSelectSource}
                onClearLogs={logs.clear}
                viewMode={appSettings?.view ?? ViewType.Cards}
                listViewConfigs={
                    appSettings?.listViewConfigs ?? ViewConfigs.ShowCover
                }
                onChangeViewMode={onChangeViewMode}
                onToggleViewConfig={onToggleViewConfig}
            />
            {searchBarVisible && (
                <SearchBar
                    value={searchInput}
                    onChange={setSearchInput}
                    onClose={() => {
                        setSearchBarVisible(false)
                        setSearchInput("")
                    }}
                />
            )}
            <input
                ref={fileInputRef}
                type="file"
                accept=".opml,.xml,text/xml,application/xml"
                hidden
                onChange={onOpmlFileChosen}
            />
            <SettingsModal
                open={settingsOpen}
                opmlBusy={opmlBusy}
                backfillBusy={backfillBusy}
                groups={groups}
                onClose={() => setSettingsOpen(false)}
                onChanged={setAppSettings}
                onImportOpml={onImportOpml}
                onExportOpml={onExportOpml}
                onBackfillThumbs={onBackfillThumbs}
                onSyncService={onSyncService}
            />
            <RulesModal
                sourceId={rulesModalSid}
                sourceName={
                    sources.find(s => s.sid === rulesModalSid)?.name ?? ""
                }
                onClose={() => setRulesModalSid(null)}
                onChanged={() => void reloadUnreadCounts()}
            />
            <SubscribeModal
                open={subscribeOpen}
                url={subscribeUrl}
                inFlight={subscribeInFlight}
                status={subscribeStatus}
                picker={picker}
                onChangeUrl={setSubscribeUrl}
                onSubmit={onSubscribe}
                onPick={onPickFeed}
                onCancelPick={onCancelPick}
                onClose={onCloseSubscribe}
            />
            <div className={layout.body}>
                {sidebarVisible && (
                    <Sidebar
                        sources={sources}
                        groups={groups}
                        unreadCounts={unreadCounts}
                        selectedSourceId={selectedSourceId}
                        selectedGroupId={selectedGroupId}
                        digestActive={digestActive}
                        expandedGroups={expandedGroups}
                        onSelectSource={onSelectSource}
                        onSelectGroup={onSelectGroup}
                        onSelectDigest={onSelectDigest}
                        onToggleGroup={onToggleGroup}
                        onRenameSource={onRenameSource}
                        onEditRules={setRulesModalSid}
                        onDeleteSource={onDeleteSource}
                        onAddFeed={() => setSubscribeOpen(true)}
                        onOpenSearch={() => setSearchBarVisible(true)}
                    />
                )}
                {renderBody()}
            </div>
        </div>
    )

    function renderBody(): React.ReactElement {
        // The digest is its own frozen feed with its own loading/empty states.
        if (selection.kind === "digest") {
            const digestEscEnabled =
                !settingsOpen &&
                !subscribeOpen &&
                rulesModalSid === null &&
                !searchBarVisible
            return (
                <DigestView
                    digest={digest}
                    viewMode={appSettings?.view ?? ViewType.Cards}
                    sourceMeta={sourceMeta}
                    hostStyle={hostStyle}
                    remount={remount}
                    escEnabled={digestEscEnabled}
                    onCtxMenu={onCtxMenu}
                />
            )
        }
        if (listError) {
            return (
                <div className={`${layout.centered} ${layout.error}`}>
                    <div>Failed to load items</div>
                    <div className={layout.errorDetail}>{listError}</div>
                    <button className={layout.retryBtn} onClick={loadItems}>
                        Retry
                    </button>
                </div>
            )
        }
        if (listLoading && items === null) {
            return <div className={layout.centered}>Loading…</div>
        }
        if (items === null) {
            return <div className={layout.centered}>Loading…</div>
        }

        const view = appSettings?.view ?? ViewType.Cards
        const emptyHint = (
            <div className={layout.emptyHint}>
                {sources.length === 0
                    ? "Click + in the sidebar to subscribe to a feed."
                    : "Try Refresh feeds, change filter, or pick a different source."}
            </div>
        )

        // All views render as a full-width feed with the article opening in an
        // overlay (matching the original Fluent Reader — no side reading pane).
        const overlayEscEnabled =
            !settingsOpen &&
            !subscribeOpen &&
            rulesModalSid === null &&
            !searchBarVisible
        return (
            <div className={layout.gridArea}>
                <ItemListHeader filter={filter} onChange={setFilter} />
                {items.length === 0 ? (
                    <div className={layout.itemColumnEmpty}>
                        <div>No items yet.</div>
                        {emptyHint}
                    </div>
                ) : (
                    <ItemList
                        items={items}
                        selectedIid={selectedItem?.iid ?? null}
                        viewMode={view}
                        sources={sourceMeta}
                        listViewConfigs={
                            appSettings?.listViewConfigs ??
                            ViewConfigs.ShowCover
                        }
                        searchQuery={searchQuery}
                        onContextMenu={(item, x, y) =>
                            setItemMenu({ item, x, y })
                        }
                        onSelect={onOpenItem}
                    />
                )}
                {selectedItem && (
                    <ArticleOverlay
                        item={selectedItem}
                        hostStyle={hostStyle}
                        articleId={`${selectedItem.iid}@${remount}`}
                        sourceName={sourceMeta.get(selectedItem.sourceId)?.name}
                        iconUrl={sourceMeta.get(selectedItem.sourceId)?.iconUrl}
                        escEnabled={overlayEscEnabled}
                        onClose={() => setSelectedItem(null)}
                        onToggleRead={onToggleRead}
                        onToggleStar={onToggleStar}
                        onToggleHidden={() =>
                            void onSetHiddenItem(
                                selectedItem,
                                !selectedItem.hidden
                            )
                        }
                        onOpenInBrowser={() => onLink(selectedItem.link)}
                        onLink={onLink}
                        onKey={onArticleKey}
                        onCtxMenu={onCtxMenu}
                    />
                )}
                {itemMenu && (
                    <ItemContextMenu
                        x={itemMenu.x}
                        y={itemMenu.y}
                        item={itemMenu.item}
                        onToggleRead={() => {
                            void onToggleReadItem(itemMenu.item)
                            setItemMenu(null)
                        }}
                        onToggleStar={() => {
                            void onToggleStarItem(itemMenu.item)
                            setItemMenu(null)
                        }}
                        onToggleHidden={() => {
                            void onSetHiddenItem(
                                itemMenu.item,
                                !itemMenu.item.hidden
                            )
                            setItemMenu(null)
                        }}
                        onOpenInBrowser={() => {
                            onLink(itemMenu.item.link)
                            setItemMenu(null)
                        }}
                        onCopyLink={() => {
                            copyText(itemMenu.item.link)
                            setItemMenu(null)
                        }}
                        onCopyTitle={() => {
                            copyText(itemMenu.item.title)
                            setItemMenu(null)
                        }}
                        onDismiss={() => setItemMenu(null)}
                    />
                )}
            </div>
        )
    }
}
