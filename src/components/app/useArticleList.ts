import * as React from "react"
import { items as itemsApi, type Item } from "../../scripts/db-bridge"
import { openExternal } from "../../scripts/shell-bridge"

export type Filter = "all" | "unread" | "starred"

export interface UseArticleListOptions {
    sourceId: number | null
    searchQuery: string
    // Split views (List/Compact) auto-open the first article in the side pane.
    // Grid views (Cards/Magazine) must NOT — the user lands on the grid and the
    // article overlay only opens on click. Defaults to true.
    autoSelectFirst?: boolean
}

export interface UseArticleList {
    items: Item[] | null
    listLoading: boolean
    listError: string | null
    filter: Filter
    selectedItem: Item | null
    unreadCounts: ReadonlyMap<number, number>
    setFilter: (f: Filter) => void
    setSelectedItem: (it: Item | null) => void
    loadItems: () => Promise<void>
    reloadUnreadCounts: () => Promise<void>
    applyItemPatch: (iid: number, patch: Partial<Item>) => void
    onToggleRead: () => Promise<void>
    onToggleStar: () => Promise<void>
    onMarkAllRead: () => Promise<void>
    onSelectNeighbor: (offset: number) => void
    onOpenSelectedLink: () => void
}

export function useArticleList(opts: UseArticleListOptions): UseArticleList {
    const { sourceId, searchQuery } = opts
    const autoSelectFirst = opts.autoSelectFirst ?? true
    const [items, setItems] = React.useState<Item[] | null>(null)
    const [selectedItem, setSelectedItem] = React.useState<Item | null>(null)
    const [listLoading, setListLoading] = React.useState(false)
    const [listError, setListError] = React.useState<string | null>(null)
    const [filter, setFilter] = React.useState<Filter>("all")
    const [unreadCounts, setUnreadCounts] = React.useState<
        ReadonlyMap<number, number>
    >(() => new Map())

    const cancelledRef = React.useRef(false)

    const reloadUnreadCounts = React.useCallback(async () => {
        try {
            const counts = await itemsApi.unreadCounts()
            if (cancelledRef.current) return
            const next = new Map<number, number>()
            for (const c of counts) next.set(c.sourceId, c.count)
            setUnreadCounts(next)
        } catch (e) {
            console.error("[useArticleList] unreadCounts failed", e)
        }
    }, [])

    const loadItems = React.useCallback(async () => {
        setListLoading(true)
        setListError(null)
        try {
            const trimmedQuery = searchQuery.trim()
            const list = trimmedQuery
                ? await itemsApi.search({
                      query: trimmedQuery,
                      limit: 50,
                      sourceId: sourceId ?? undefined,
                      hasRead: filter === "unread" ? false : undefined,
                      starred: filter === "starred" ? true : undefined,
                  })
                : await itemsApi.list({
                      limit: 50,
                      sourceId: sourceId ?? undefined,
                      hasRead: filter === "unread" ? false : undefined,
                      starred: filter === "starred" ? true : undefined,
                  })
            if (cancelledRef.current) return
            setItems(list)
            // Preserve a still-valid selection across reloads; otherwise the
            // auto-select-first effect below decides whether to pick list[0]
            // (split views) or leave it null (grid views).
            setSelectedItem(prev =>
                prev && list.some(i => i.iid === prev.iid) ? prev : null
            )
            // Search is a view — don't re-fetch sidebar unread counts.
            if (!trimmedQuery) void reloadUnreadCounts()
        } catch (e) {
            if (cancelledRef.current) return
            setListError(String((e as Error)?.message ?? e))
        } finally {
            if (!cancelledRef.current) setListLoading(false)
        }
    }, [filter, sourceId, searchQuery, reloadUnreadCounts])

    React.useEffect(() => {
        cancelledRef.current = false
        loadItems()
        return () => {
            cancelledRef.current = true
        }
    }, [loadItems])

    // Split views auto-open the first article once a list is present and nothing
    // valid is selected. Grid views opt out (autoSelectFirst=false) so the
    // overlay only opens on an explicit click. Keyed on items + the flag so it
    // also fires when settings resolve and flip the layout family on cold start.
    React.useEffect(() => {
        if (!autoSelectFirst) return
        if (!items || items.length === 0) return
        setSelectedItem(prev =>
            prev && items.some(i => i.iid === prev.iid) ? prev : items[0]
        )
    }, [autoSelectFirst, items])

    const bumpUnread = React.useCallback(
        (sid: number, delta: number) => {
            setUnreadCounts(prev => {
                const next = new Map(prev)
                const cur = next.get(sid) ?? 0
                const after = Math.max(0, cur + delta)
                if (after === 0) next.delete(sid)
                else next.set(sid, after)
                return next
            })
        },
        []
    )

    const applyItemPatch = React.useCallback(
        (iid: number, patch: Partial<Item>) => {
            setItems(prev =>
                prev
                    ? prev.map(it => (it.iid === iid ? { ...it, ...patch } : it))
                    : prev
            )
            setSelectedItem(prev =>
                prev && prev.iid === iid ? { ...prev, ...patch } : prev
            )
        },
        []
    )

    const onToggleRead = React.useCallback(async () => {
        if (!selectedItem) return
        const next = !selectedItem.hasRead
        const delta = next ? -1 : +1
        applyItemPatch(selectedItem.iid, { hasRead: next })
        bumpUnread(selectedItem.sourceId, delta)
        try {
            await itemsApi.markRead(selectedItem.iid, next)
        } catch (e) {
            applyItemPatch(selectedItem.iid, { hasRead: !next })
            bumpUnread(selectedItem.sourceId, -delta)
            console.error("[useArticleList] markRead failed", e)
        }
    }, [selectedItem, applyItemPatch, bumpUnread])

    const onToggleStar = React.useCallback(async () => {
        if (!selectedItem) return
        const next = !selectedItem.starred
        applyItemPatch(selectedItem.iid, { starred: next })
        try {
            await itemsApi.setStarred(selectedItem.iid, next)
        } catch (e) {
            applyItemPatch(selectedItem.iid, { starred: !next })
            console.error("[useArticleList] setStarred failed", e)
        }
    }, [selectedItem, applyItemPatch])

    const onMarkAllRead = React.useCallback(async () => {
        if (!items) return
        const unread = items.filter(i => !i.hasRead)
        if (unread.length === 0) return
        const sourceDeltas = new Map<number, number>()
        for (const it of unread) {
            sourceDeltas.set(
                it.sourceId,
                (sourceDeltas.get(it.sourceId) ?? 0) + 1
            )
        }
        setItems(prev =>
            prev ? prev.map(it => ({ ...it, hasRead: true })) : prev
        )
        setSelectedItem(prev => (prev ? { ...prev, hasRead: true } : prev))
        for (const [sid, n] of sourceDeltas) bumpUnread(sid, -n)
        const results = await Promise.allSettled(
            unread.map(it => itemsApi.markRead(it.iid, true))
        )
        const failed = results.filter(r => r.status === "rejected").length
        if (failed > 0) {
            console.error(
                `[useArticleList] mark all read: ${failed} of ${unread.length} failed`
            )
            await loadItems()
        }
    }, [items, loadItems, bumpUnread])

    const onSelectNeighbor = React.useCallback(
        (offset: number) => {
            if (!items || items.length === 0) return
            const idx = selectedItem
                ? items.findIndex(i => i.iid === selectedItem.iid)
                : -1
            const nextIdx = Math.max(
                0,
                Math.min(items.length - 1, (idx < 0 ? 0 : idx) + offset)
            )
            if (nextIdx !== idx) setSelectedItem(items[nextIdx])
        },
        [items, selectedItem]
    )

    const onOpenSelectedLink = React.useCallback(() => {
        if (!selectedItem?.link) return
        openExternal(selectedItem.link).catch(err =>
            console.error("[useArticleList] openExternal failed", err)
        )
    }, [selectedItem])

    return {
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
        applyItemPatch,
        onToggleRead,
        onToggleStar,
        onMarkAllRead,
        onSelectNeighbor,
        onOpenSelectedLink,
    }
}
