import * as React from "react"
import type { HostStyle } from "./article/iframe-bootstrap"
import { openExternal } from "../scripts/shell-bridge"
import {
    groups as groupsApi,
    sources as sourcesApi,
    items as itemsApi,
    type Group,
    type Source,
} from "../scripts/db-bridge"
import {
    refreshAll,
    isRefreshSuccess,
    type RefreshResult,
} from "../scripts/feeds"
import { feeds as feedsApi, type DiscoveredFeed } from "../scripts/feeds-bridge"
import { startAutoRefresh } from "../scripts/auto-refresh"
import { NavBar } from "./app/NavBar"
import { SearchBar } from "./app/SearchBar"
import { SubscribeModal } from "./app/SubscribeModal"
import { ItemListHeader } from "./app/ItemListHeader"
import { ItemList } from "./app/ItemList"
import { ArticleOverlay } from "./app/ArticleOverlay"
import { Sidebar } from "./app/Sidebar"
import { RulesModal } from "./app/RulesModal"
import { SettingsModal } from "./app/SettingsModal"
import { useArticleList } from "./app/useArticleList"
import {
    settings,
    ViewType,
    ViewConfigs,
    type SettingsShape,
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

export function App(): React.ReactElement {
    const [sources, setSources] = React.useState<Source[]>([])
    const [groups, setGroups] = React.useState<Group[]>([])
    const [expandedGroups, setExpandedGroups] = React.useState<
        ReadonlySet<number>
    >(() => new Set())
    const [selectedSourceId, setSelectedSourceId] = React.useState<
        number | null
    >(null)
    const [searchInput, setSearchInput] = React.useState("")
    const [searchQuery, setSearchQuery] = React.useState("")

    React.useEffect(() => {
        const t = setTimeout(() => setSearchQuery(searchInput), 200)
        return () => clearTimeout(t)
    }, [searchInput])

    const [appSettings, setAppSettings] = React.useState<SettingsShape | null>(
        null
    )

    const list = useArticleList({
        sourceId: selectedSourceId,
        searchQuery,
        // All views use the full-width feed + article overlay, so nothing is
        // auto-opened — the overlay appears only when the user clicks an item.
        autoSelectFirst: false,
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
        loadItems,
        reloadUnreadCounts,
        onToggleRead,
        onToggleStar,
        onMarkAllRead,
        onSelectNeighbor,
        onOpenSelectedLink,
    } = list

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
        // Capture source names BEFORE the await so a delete/rename mid-refresh
        // can't blank out the log row's display name.
        const names = new Map(sources.map(s => [s.sid, s.name]))
        try {
            const sids = sources.map(s => s.sid)
            const results = await refreshAll(sids)
            if (cancelledRef.current) return
            setRefreshStatus(formatRefreshSummary(results))
            logs.appendRefreshResults(results, names, "manual")
            await loadItems()
        } catch (e) {
            if (cancelledRef.current) return
            setRefreshStatus(
                "refresh failed: " + String((e as Error)?.message ?? e)
            )
        } finally {
            if (!cancelledRef.current) setRefreshInFlight(false)
        }
    }, [refreshInFlight, loadItems, sources, logs])

    const onSelectSource = React.useCallback((sid: number | null) => {
        setSelectedSourceId(sid)
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
                if (selectedSourceId === s.sid) setSelectedSourceId(null)
                await loadItems()
                await reloadUnreadCounts()
            } catch (e) {
                console.error("[App] delete source failed", e)
                window.alert(
                    "Delete failed: " + String((e as Error)?.message ?? e)
                )
            }
        },
        [selectedSourceId, loadItems, reloadUnreadCounts]
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

    const onLink = React.useCallback((url: string) => {
        openExternal(url).catch(err => {
            console.error("[App] openExternal failed", err)
            window.alert(
                "Open link failed: " + String((err as Error)?.message ?? err)
            )
        })
    }, [])

    const handleShortcut = React.useCallback(
        (key: string): boolean => {
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

    const hasUnread = !!items && items.some(i => !i.hasRead)

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
                onMarkAllRead={onMarkAllRead}
                onRefresh={onRefresh}
                onOpenSettings={() => setSettingsOpen(true)}
                onJumpToSource={setSelectedSourceId}
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
                onClose={() => setSettingsOpen(false)}
                onChanged={setAppSettings}
                onImportOpml={onImportOpml}
                onExportOpml={onExportOpml}
                onBackfillThumbs={onBackfillThumbs}
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
                        expandedGroups={expandedGroups}
                        onSelectSource={onSelectSource}
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
                        onSelect={setSelectedItem}
                    />
                )}
                {selectedItem && (
                    <ArticleOverlay
                        item={selectedItem}
                        hostStyle={hostStyle}
                        articleId={`${selectedItem.iid}@${remount}`}
                        escEnabled={overlayEscEnabled}
                        onClose={() => setSelectedItem(null)}
                        onToggleRead={onToggleRead}
                        onToggleStar={onToggleStar}
                        onLink={onLink}
                        onKey={onArticleKey}
                        onCtxMenu={onCtxMenu}
                    />
                )}
            </div>
        )
    }
}
