import * as React from "react"
import { ArticleView } from "./ArticleView"
import { openExternal } from "../../scripts/shell-bridge"
import {
    items as itemsApi,
    sources as sourcesApi,
    type Item,
} from "../../scripts/db-bridge"

// SPIKE ONLY: delete this seed path (and the spike://demo rows) before v2 ships.
// Sources/items with url prefix `spike://` are demo-only and never come from real feeds.
const SEED_ENABLED = true
const DEMO_SOURCE_URL = "spike://demo"
const DEMO_SOURCE_NAME = "Demo"

const SEED_ITEMS: ReadonlyArray<{ title: string; html: string }> = [
    {
        title: "Welcome to fluent-reader v2",
        html: `<h1>Welcome</h1><p>This article is rendered through the sandboxed iframe pipeline (<code>sandbox="allow-scripts"</code> + strict CSP). Test the link handler: <a href="https://example.com">https://example.com</a>.</p>`,
    },
    {
        title: "Renderer security model",
        html: `<h2>How rendering works</h2><p>HTML from feeds passes through <code>sanitize-html</code> with a tight allowlist before reaching the iframe. Inline scripts, <code>&lt;svg&gt;</code>, <code>&lt;math&gt;</code>, and CSS that could exfiltrate are stripped.</p><blockquote>Each article gets a fresh iframe — the <code>articleId</code> prop keys the iframe element.</blockquote>`,
    },
    {
        title: "Still TODO",
        html: `<h2>Out of scope for this commit</h2><ul><li>Toolbar (mark read, font size, open external)</li><li>Feed ingestion (RSS fetch → parse → upsert)</li><li>Replacing the legacy redux <code>&lt;Root /&gt;</code></li><li>SQLite WAL mode + pool sizing</li></ul>`,
    },
]

const overlayStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    zIndex: 99998,
    display: "flex",
    flexDirection: "column",
}
const openBtnStyle: React.CSSProperties = {
    position: "fixed",
    right: 16,
    bottom: 16,
    zIndex: 99999,
    padding: "10px 14px",
    borderRadius: 4,
    border: "1px solid #444",
    background: "#222",
    color: "#fff",
    fontSize: 13,
    cursor: "pointer",
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
const listRowStyle = (selected: boolean): React.CSSProperties => ({
    padding: "10px 12px",
    borderBottom: "1px solid #eee",
    cursor: "pointer",
    background: selected ? "#dde7f7" : "transparent",
    fontSize: 13,
})
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
const seedErrorStyle: React.CSSProperties = {
    marginTop: 8,
    color: "#a00",
    fontSize: 12,
}

async function ensureDemoSource(): Promise<number> {
    const existing = await sourcesApi.list()
    const found = existing.find(s => s.url === DEMO_SOURCE_URL)
    if (found) return found.sid
    const created = await sourcesApi.create({
        url: DEMO_SOURCE_URL,
        name: DEMO_SOURCE_NAME,
    })
    return created.sid
}

async function seedIfEmpty(): Promise<void> {
    const sourceId = await ensureDemoSource()
    // Backend `items_insert` is bare INSERT (no ON CONFLICT) — must dedup before write.
    // Still racy on rapid double-click; the in-flight flag in the button gates that.
    const probe = await itemsApi.list({ sourceId, limit: 1 })
    if (probe.length > 0) return
    const now = Date.now()
    await itemsApi.insert(
        SEED_ITEMS.map((s, i) => ({
            sourceId,
            title: s.title,
            link: `${DEMO_SOURCE_URL}/item-${i}`,
            dateMs: now - i * 60_000,
            content: s.html,
            snippet: s.title,
        }))
    )
}

export function Demo(): React.ReactElement {
    const [show, setShow] = React.useState(false)
    const [items, setItems] = React.useState<Item[] | null>(null)
    const [selectedItem, setSelectedItem] = React.useState<Item | null>(null)
    const [listLoading, setListLoading] = React.useState(false)
    const [listError, setListError] = React.useState<string | null>(null)
    const [seedError, setSeedError] = React.useState<string | null>(null)
    const [seedInFlight, setSeedInFlight] = React.useState(false)
    const [remount, setRemount] = React.useState(0)

    const cancelledRef = React.useRef(false)

    const loadItems = React.useCallback(async () => {
        setListLoading(true)
        setListError(null)
        try {
            const list = await itemsApi.list({ limit: 50 })
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
    }, [])

    React.useEffect(() => {
        if (!show) return
        cancelledRef.current = false
        loadItems()
        return () => {
            cancelledRef.current = true
        }
    }, [show, loadItems])

    React.useEffect(() => {
        if (!show) return
        function onWindowKey(e: KeyboardEvent): void {
            if (e.key === "Escape") setShow(false)
        }
        window.addEventListener("keydown", onWindowKey)
        return () => window.removeEventListener("keydown", onWindowKey)
    }, [show])

    const onSeed = React.useCallback(async () => {
        if (seedInFlight) return
        setSeedInFlight(true)
        setSeedError(null)
        try {
            await seedIfEmpty()
            if (cancelledRef.current) return
            await loadItems()
        } catch (e) {
            if (cancelledRef.current) return
            setSeedError(String((e as Error)?.message ?? e))
        } finally {
            if (!cancelledRef.current) setSeedInFlight(false)
        }
    }, [seedInFlight, loadItems])

    const onLink = React.useCallback((url: string) => {
        openExternal(url).catch(err => {
            console.error("[Demo] openExternal failed", err)
            window.alert("Open link failed: " + String((err as Error)?.message ?? err))
        })
    }, [])

    const onArticleKey = React.useCallback((key: string) => {
        if (key === "Escape") setShow(false)
    }, [])

    const onCtxMenu = React.useCallback(
        (d: { x: number; y: number; text: string | null; href: string | null }) => {
            console.log("[Demo] ctxmenu", d)
        },
        []
    )

    if (!show) {
        return (
            <button style={openBtnStyle} onClick={() => setShow(true)}>
                Open v2 demo
            </button>
        )
    }

    return (
        <div style={overlayStyle}>
            <div style={headerStyle}>
                <span style={{ flex: 1 }}>
                    v2 demo{items ? ` — ${items.length} items` : ""}
                    {selectedItem ? ` — ${selectedItem.title}` : ""}
                </span>
                <button
                    style={selectedItem ? headerBtnStyle : headerBtnDisabledStyle}
                    disabled={!selectedItem}
                    onClick={() => setRemount(n => n + 1)}>
                    Remount iframe
                </button>
                <button style={headerBtnStyle} onClick={() => setShow(false)}>
                    Close (Esc)
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
                        <div style={{ marginBottom: 12 }}>No items in db.</div>
                        {SEED_ENABLED ? (
                            <>
                                <button
                                    style={
                                        seedInFlight
                                            ? headerBtnDisabledStyle
                                            : headerBtnStyle
                                    }
                                    disabled={seedInFlight}
                                    onClick={onSeed}>
                                    {seedInFlight ? "Seeding…" : "Seed test items"}
                                </button>
                                {seedError && (
                                    <div style={seedErrorStyle}>{seedError}</div>
                                )}
                            </>
                        ) : (
                            <div style={{ fontSize: 11, color: "#666" }}>
                                Subscribe to a feed first.
                            </div>
                        )}
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
                                style={listRowStyle(selectedItem?.iid === it.iid)}
                                onClick={() => setSelectedItem(it)}>
                                <div style={{ fontWeight: 500 }}>{it.title}</div>
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
