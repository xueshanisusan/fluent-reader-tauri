import * as React from "react"
import { ArticleView } from "./article/ArticleView"
import { openExternal } from "../scripts/shell-bridge"
import {
    groups as groupsApi,
    sources as sourcesApi,
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
import { Header } from "./app/Header"
import { SubscribeBar } from "./app/SubscribeBar"
import { FilterBar } from "./app/FilterBar"
import { ItemList } from "./app/ItemList"
import { Sidebar } from "./app/Sidebar"
import { useArticleList } from "./app/useArticleList"
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

    const list = useArticleList({ sourceId: selectedSourceId })
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
    const [remount, setRemount] = React.useState(0)

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
                void loadItems()
            },
            onError: e => {
                console.error("[App] auto-refresh tick failed", e)
            },
        })
        return stop
    }, [loadItems])

    const finalizeSubscribe = React.useCallback(
        async (feed: DiscoveredFeed) => {
            const created = await sourcesApi.create({
                url: feed.url,
                name: feed.title?.trim() || feed.url,
            })
            const outcome = await feedsApi.ingest(created.sid)
            if (cancelledRef.current) return
            const summary =
                outcome.kind === "updated"
                    ? `subscribed · ${outcome.inserted} new`
                    : `subscribed · not modified`
            setSubscribeStatus(`${feed.url} — ${summary}`)
            setSubscribeUrl("")
            setPicker(null)
            await loadSourcesAndGroups()
            await loadItems()
        },
        [loadItems, loadSourcesAndGroups]
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

    const onRefresh = React.useCallback(async () => {
        if (refreshInFlight) return
        setRefreshInFlight(true)
        setRefreshStatus("refreshing…")
        try {
            const sids = sources.map(s => s.sid)
            const results = await refreshAll(sids)
            if (cancelledRef.current) return
            setRefreshStatus(formatRefreshSummary(results))
            await loadItems()
        } catch (e) {
            if (cancelledRef.current) return
            setRefreshStatus(
                "refresh failed: " + String((e as Error)?.message ?? e)
            )
        } finally {
            if (!cancelledRef.current) setRefreshInFlight(false)
        }
    }, [refreshInFlight, loadItems, sources])

    const onSelectSource = React.useCallback((sid: number | null) => {
        setSelectedSourceId(sid)
    }, [])

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
            <Header
                itemsCount={items ? items.length : null}
                selectedItem={selectedItem}
                refreshInFlight={refreshInFlight}
                refreshStatus={refreshStatus}
                hasUnread={hasUnread}
                onToggleRead={onToggleRead}
                onToggleStar={onToggleStar}
                onMarkAllRead={onMarkAllRead}
                onRefresh={onRefresh}
                onRemountIframe={() => setRemount(n => n + 1)}
            />
            <SubscribeBar
                url={subscribeUrl}
                inFlight={subscribeInFlight}
                status={subscribeStatus}
                picker={picker}
                onChangeUrl={setSubscribeUrl}
                onSubmit={onSubscribe}
                onPick={onPickFeed}
                onCancelPick={onCancelPick}
            />
            <FilterBar filter={filter} onChange={setFilter} />
            <div className={layout.body}>
                <Sidebar
                    sources={sources}
                    groups={groups}
                    unreadCounts={unreadCounts}
                    selectedSourceId={selectedSourceId}
                    expandedGroups={expandedGroups}
                    onSelectSource={onSelectSource}
                    onToggleGroup={onToggleGroup}
                    onRenameSource={onRenameSource}
                    onDeleteSource={onDeleteSource}
                />
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
        if (items && items.length === 0) {
            return (
                <div className={layout.centered}>
                    <div>No items yet.</div>
                    <div className={layout.emptyHint}>
                        {sources.length === 0
                            ? "Subscribe to a feed in the bar above."
                            : "Try Refresh feeds, change filter, or pick a different source."}
                    </div>
                </div>
            )
        }
        if (items && items.length > 0) {
            return (
                <>
                    <ItemList
                        items={items}
                        selectedIid={selectedItem?.iid ?? null}
                        onSelect={setSelectedItem}
                    />
                    <div className={layout.articlePane}>
                        {selectedItem && (
                            <ArticleView
                                key={`${selectedItem.iid}@${remount}`}
                                html={selectedItem.content}
                                articleId={`${selectedItem.iid}@${remount}`}
                                onLink={onLink}
                                onKey={onArticleKey}
                                onCtxMenu={onCtxMenu}
                            />
                        )}
                    </div>
                </>
            )
        }
        return <div className={layout.centered}>Loading…</div>
    }
}
