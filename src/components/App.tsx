import * as React from "react"
import { ArticleView } from "./article/ArticleView"
import { openExternal } from "../scripts/shell-bridge"
import {
    items as itemsApi,
    sources as sourcesApi,
    type Item,
} from "../scripts/db-bridge"
import { refreshAll, isRefreshSuccess, type RefreshResult } from "../scripts/feeds"
import { feeds as feedsApi, type DiscoveredFeed } from "../scripts/feeds-bridge"
import { startAutoRefresh } from "../scripts/auto-refresh"

const appStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    background: "#fff",
    color: "#222",
    fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
}
const headerStyle: React.CSSProperties = {
    display: "flex",
    gap: 8,
    padding: 8,
    background: "#222",
    color: "#fff",
    fontSize: 13,
    alignItems: "center",
}
const headerBtnStyle: React.CSSProperties = {
    padding: "4px 10px",
    background: "#444",
    border: "1px solid #666",
    color: "#fff",
    cursor: "pointer",
}
const headerBtnDisabledStyle: React.CSSProperties = {
    ...headerBtnStyle,
    opacity: 0.5,
    cursor: "not-allowed",
}
const bodyStyle: React.CSSProperties = {
    flex: 1,
    display: "flex",
    background: "#fff",
    overflow: "hidden",
}
const listStyle: React.CSSProperties = {
    width: 280,
    borderRight: "1px solid #ddd",
    overflowY: "auto",
    flexShrink: 0,
}
const listRowStyle = (selected: boolean, hasRead: boolean): React.CSSProperties => ({
    padding: "10px 12px",
    borderBottom: "1px solid #eee",
    cursor: "pointer",
    background: selected ? "#dde7f7" : "transparent",
    fontSize: 13,
    color: hasRead ? "#999" : "#222",
})
const starIconStyle: React.CSSProperties = {
    marginLeft: 6,
    color: "#e6b800",
    fontSize: 12,
}
const articlePaneStyle: React.CSSProperties = {
    flex: 1,
    position: "relative",
    overflow: "hidden",
}
const centeredStyle: React.CSSProperties = {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    textAlign: "center",
    color: "#444",
}
const errorPaneStyle: React.CSSProperties = {
    ...centeredStyle,
    color: "#a00",
    flexDirection: "column",
    gap: 8,
}
const statusStyle: React.CSSProperties = {
    fontSize: 11,
    color: "#bbb",
    marginLeft: 8,
    maxWidth: 360,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
}
const filterRowStyle: React.CSSProperties = {
    display: "flex",
    gap: 4,
    padding: "6px 8px",
    background: "#f3f3f3",
    borderBottom: "1px solid #ddd",
}
const filterChipStyle = (active: boolean): React.CSSProperties => ({
    padding: "3px 12px",
    fontSize: 12,
    border: "1px solid",
    borderColor: active ? "#446" : "#bbb",
    background: active ? "#446" : "#fff",
    color: active ? "#fff" : "#333",
    borderRadius: 12,
    cursor: "pointer",
})
const subscribeRowStyle: React.CSSProperties = {
    display: "flex",
    gap: 8,
    padding: "4px 8px",
    background: "#1a1a1a",
    color: "#fff",
    fontSize: 12,
    alignItems: "center",
    borderTop: "1px solid #333",
}
const subscribeInputStyle: React.CSSProperties = {
    flex: 1,
    padding: "4px 8px",
    background: "#111",
    border: "1px solid #444",
    color: "#fff",
    fontSize: 12,
    minWidth: 0,
}
const pickerStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    flex: 1,
}
const pickerRowStyle: React.CSSProperties = {
    display: "flex",
    gap: 6,
    alignItems: "center",
}
const pickerBtnStyle: React.CSSProperties = {
    padding: "2px 8px",
    background: "#446",
    border: "1px solid #668",
    color: "#fff",
    cursor: "pointer",
    fontSize: 11,
}

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

type Filter = "all" | "unread" | "starred"

export function App(): React.ReactElement {
    const [items, setItems] = React.useState<Item[] | null>(null)
    const [selectedItem, setSelectedItem] = React.useState<Item | null>(null)
    const [listLoading, setListLoading] = React.useState(false)
    const [listError, setListError] = React.useState<string | null>(null)
    const [refreshInFlight, setRefreshInFlight] = React.useState(false)
    const [refreshStatus, setRefreshStatus] = React.useState<string | null>(null)
    const [subscribeUrl, setSubscribeUrl] = React.useState("")
    const [subscribeInFlight, setSubscribeInFlight] = React.useState(false)
    const [subscribeStatus, setSubscribeStatus] = React.useState<string | null>(null)
    const [picker, setPicker] = React.useState<DiscoveredFeed[] | null>(null)
    const [remount, setRemount] = React.useState(0)
    const [filter, setFilter] = React.useState<Filter>("all")

    const cancelledRef = React.useRef(false)

    const loadItems = React.useCallback(async () => {
        setListLoading(true)
        setListError(null)
        try {
            const list = await itemsApi.list({
                limit: 50,
                hasRead: filter === "unread" ? false : undefined,
                starred: filter === "starred" ? true : undefined,
            })
            if (cancelledRef.current) return
            setItems(list)
            setSelectedItem(prev => {
                if (prev && list.some(i => i.iid === prev.iid)) return prev
                return list.length > 0 ? list[0] : null
            })
        } catch (e) {
            if (cancelledRef.current) return
            setListError(String((e as Error)?.message ?? e))
        } finally {
            if (!cancelledRef.current) setListLoading(false)
        }
    }, [filter])

    React.useEffect(() => {
        cancelledRef.current = false
        loadItems()
        return () => {
            cancelledRef.current = true
        }
    }, [loadItems])

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
                setRefreshStatus(`auto: ${results.length} checked · ${inserted} new`)
                void loadItems()
            },
            onError: e => {
                console.error("[App] auto-refresh tick failed", e)
            },
        })
        return stop
    }, [loadItems])

    const applyItemPatch = React.useCallback(
        (iid: number, patch: Partial<Item>) => {
            setItems(prev =>
                prev ? prev.map(it => (it.iid === iid ? { ...it, ...patch } : it)) : prev
            )
            setSelectedItem(prev => (prev && prev.iid === iid ? { ...prev, ...patch } : prev))
        },
        []
    )

    const onToggleRead = React.useCallback(async () => {
        if (!selectedItem) return
        const next = !selectedItem.hasRead
        applyItemPatch(selectedItem.iid, { hasRead: next })
        try {
            await itemsApi.markRead(selectedItem.iid, next)
        } catch (e) {
            applyItemPatch(selectedItem.iid, { hasRead: !next })
            console.error("[App] markRead failed", e)
        }
    }, [selectedItem, applyItemPatch])

    const onToggleStar = React.useCallback(async () => {
        if (!selectedItem) return
        const next = !selectedItem.starred
        applyItemPatch(selectedItem.iid, { starred: next })
        try {
            await itemsApi.setStarred(selectedItem.iid, next)
        } catch (e) {
            applyItemPatch(selectedItem.iid, { starred: !next })
            console.error("[App] setStarred failed", e)
        }
    }, [selectedItem, applyItemPatch])

    const onMarkAllRead = React.useCallback(async () => {
        if (!items) return
        const unread = items.filter(i => !i.hasRead)
        if (unread.length === 0) return
        setItems(prev => (prev ? prev.map(it => ({ ...it, hasRead: true })) : prev))
        setSelectedItem(prev => (prev ? { ...prev, hasRead: true } : prev))
        const results = await Promise.allSettled(
            unread.map(it => itemsApi.markRead(it.iid, true))
        )
        const failed = results.filter(r => r.status === "rejected").length
        if (failed > 0) {
            console.error(`[App] mark all read: ${failed} of ${unread.length} failed`)
            await loadItems()
        }
    }, [items, loadItems])

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
            await loadItems()
        },
        [loadItems]
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
                kind ? `subscribe failed (${kind}): ${message}` : `subscribe failed: ${message}`
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

    const onRefresh = React.useCallback(async () => {
        if (refreshInFlight) return
        setRefreshInFlight(true)
        setRefreshStatus("refreshing…")
        try {
            const sources = await sourcesApi.list()
            const sids = sources.map(s => s.sid)
            const results = await refreshAll(sids)
            if (cancelledRef.current) return
            setRefreshStatus(formatRefreshSummary(results))
            await loadItems()
        } catch (e) {
            if (cancelledRef.current) return
            setRefreshStatus("refresh failed: " + String((e as Error)?.message ?? e))
        } finally {
            if (!cancelledRef.current) setRefreshInFlight(false)
        }
    }, [refreshInFlight, loadItems])

    const onLink = React.useCallback((url: string) => {
        openExternal(url).catch(err => {
            console.error("[App] openExternal failed", err)
            window.alert("Open link failed: " + String((err as Error)?.message ?? err))
        })
    }, [])

    const onArticleKey = React.useCallback(() => {}, [])
    const onCtxMenu = React.useCallback(
        (d: { x: number; y: number; text: string | null; href: string | null }) => {
            console.log("[App] ctxmenu", d)
        },
        []
    )

    return (
        <div style={appStyle}>
            <div style={headerStyle}>
                <span style={{ flex: 1 }}>
                    fluent-reader{items ? ` — ${items.length} items` : ""}
                    {selectedItem ? ` — ${selectedItem.title}` : ""}
                    {refreshStatus && <span style={statusStyle}>{refreshStatus}</span>}
                </span>
                <button
                    style={selectedItem ? headerBtnStyle : headerBtnDisabledStyle}
                    disabled={!selectedItem}
                    onClick={onToggleRead}>
                    {selectedItem?.hasRead ? "Mark unread" : "Mark read"}
                </button>
                <button
                    style={selectedItem ? headerBtnStyle : headerBtnDisabledStyle}
                    disabled={!selectedItem}
                    onClick={onToggleStar}>
                    {selectedItem?.starred ? "Unstar" : "Star"}
                </button>
                <button
                    style={
                        items && items.some(i => !i.hasRead)
                            ? headerBtnStyle
                            : headerBtnDisabledStyle
                    }
                    disabled={!items || !items.some(i => !i.hasRead)}
                    onClick={onMarkAllRead}>
                    Mark all read
                </button>
                <button
                    style={refreshInFlight ? headerBtnDisabledStyle : headerBtnStyle}
                    disabled={refreshInFlight}
                    onClick={onRefresh}>
                    {refreshInFlight ? "Refreshing…" : "Refresh feeds"}
                </button>
                <button
                    style={selectedItem ? headerBtnStyle : headerBtnDisabledStyle}
                    disabled={!selectedItem}
                    onClick={() => setRemount(n => n + 1)}>
                    Remount iframe
                </button>
            </div>
            <div style={subscribeRowStyle}>
                {picker ? (
                    <div style={pickerStyle}>
                        {picker.map((f, i) => (
                            <div key={`${f.url}-${i}`} style={pickerRowStyle}>
                                <button
                                    style={pickerBtnStyle}
                                    disabled={subscribeInFlight}
                                    onClick={() => onPickFeed(f)}>
                                    Add
                                </button>
                                <span
                                    style={{
                                        flex: 1,
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                    }}>
                                    {f.title ? `${f.title} — ` : ""}
                                    <span style={{ color: "#aaa" }}>{f.url}</span>
                                </span>
                            </div>
                        ))}
                        <div style={pickerRowStyle}>
                            <button
                                style={pickerBtnStyle}
                                onClick={() => {
                                    setPicker(null)
                                    setSubscribeStatus(null)
                                }}>
                                Cancel
                            </button>
                        </div>
                    </div>
                ) : (
                    <>
                        <span>Add feed:</span>
                        <input
                            style={subscribeInputStyle}
                            type="text"
                            placeholder="https://example.com or https://example.com/feed.xml"
                            value={subscribeUrl}
                            onChange={e => setSubscribeUrl(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === "Enter") onSubscribe()
                            }}
                            disabled={subscribeInFlight}
                        />
                        <button
                            style={
                                subscribeInFlight || !subscribeUrl.trim()
                                    ? headerBtnDisabledStyle
                                    : headerBtnStyle
                            }
                            disabled={subscribeInFlight || !subscribeUrl.trim()}
                            onClick={onSubscribe}>
                            {subscribeInFlight ? "…" : "Add"}
                        </button>
                    </>
                )}
                {subscribeStatus && !picker && (
                    <span style={statusStyle}>{subscribeStatus}</span>
                )}
            </div>
            <div style={filterRowStyle}>
                <button
                    style={filterChipStyle(filter === "all")}
                    onClick={() => setFilter("all")}>
                    All
                </button>
                <button
                    style={filterChipStyle(filter === "unread")}
                    onClick={() => setFilter("unread")}>
                    Unread
                </button>
                <button
                    style={filterChipStyle(filter === "starred")}
                    onClick={() => setFilter("starred")}>
                    Starred
                </button>
            </div>
            <div style={bodyStyle}>{renderBody()}</div>
        </div>
    )

    function renderBody(): React.ReactElement {
        if (listError) {
            return (
                <div style={errorPaneStyle}>
                    <div>Failed to load items</div>
                    <div style={{ fontSize: 11 }}>{listError}</div>
                    <button style={headerBtnStyle} onClick={loadItems}>
                        Retry
                    </button>
                </div>
            )
        }
        if (listLoading && items === null) {
            return <div style={centeredStyle}>Loading…</div>
        }
        if (items && items.length === 0) {
            return (
                <div style={centeredStyle}>
                    <div>
                        <div style={{ marginBottom: 12 }}>No items yet.</div>
                        <div style={{ fontSize: 11, color: "#666" }}>
                            Subscribe to a feed in the bar above.
                        </div>
                    </div>
                </div>
            )
        }
        if (items && items.length > 0) {
            return (
                <>
                    <div style={listStyle}>
                        {items.map(it => (
                            <div
                                key={it.iid}
                                style={listRowStyle(selectedItem?.iid === it.iid, it.hasRead)}
                                onClick={() => setSelectedItem(it)}>
                                <div style={{ fontWeight: it.hasRead ? 400 : 600 }}>
                                    {it.title}
                                    {it.starred && <span style={starIconStyle}>★</span>}
                                </div>
                                <div
                                    style={{
                                        fontSize: 11,
                                        color: "#888",
                                        marginTop: 2,
                                    }}>
                                    {new Date(it.dateMs).toLocaleString()}
                                </div>
                            </div>
                        ))}
                    </div>
                    <div style={articlePaneStyle}>
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
        return <div style={centeredStyle}>Loading…</div>
    }
}
