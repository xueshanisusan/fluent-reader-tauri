import * as React from "react"
import { items as itemsApi, type Item } from "../../scripts/db-bridge"
import { openExternal } from "../../scripts/shell-bridge"
import type { MarkKind } from "../../scripts/service-bridge"

export type Filter = "all" | "unread" | "starred" | "hidden"

export interface UseArticleListOptions {
    sourceId: number | null
    // When set, the list is scoped to all sources in this group (a whole-group
    // feed). Mutually exclusive with sourceId — the App passes one or the other.
    groupId: number | null
    searchQuery: string
    // When true, the first article is auto-selected once a list loads. The app
    // passes false (all views open the article overlay only on click), but the
    // option is kept for flexibility. Defaults to true.
    autoSelectFirst?: boolean
    // Best-effort push of a local read/star change to the sync service. Called
    // after the local DB mutation succeeds; a no-op when no service is active or
    // the item isn't service-backed. Fire-and-forget (never awaited).
    pushItemMark?: (item: Item, kind: MarkKind) => void
    // Best-effort "mark whole source read" push for onMarkAllRead.
    pushSourceRead?: (sourceId: number, beforeMs: number) => void
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
    // Open an item into the article overlay. Selects it and, if it was unread,
    // marks it read (matches the original Fluent Reader's open-to-read). The
    // item stays in the list — even under the "unread" filter it only fades; a
    // later reload drops it.
    onOpenItem: (item: Item) => void
    loadItems: () => Promise<void>
    reloadUnreadCounts: () => Promise<void>
    applyItemPatch: (iid: number, patch: Partial<Item>) => void
    onToggleRead: () => Promise<void>
    onToggleStar: () => Promise<void>
    // Item-targeted variants for the right-click context menu (act on any row,
    // not just the selected one). onToggleRead/onToggleStar delegate to these.
    onToggleReadItem: (item: Item) => Promise<void>
    onToggleStarItem: (item: Item) => Promise<void>
    // Hide (hidden=true) or unhide (hidden=false) an item. Either way the item
    // leaves the current view, so it's removed from the list optimistically.
    onSetHiddenItem: (item: Item, hidden: boolean) => Promise<void>
    onMarkAllRead: () => Promise<void>
    onSelectNeighbor: (offset: number) => void
    onOpenSelectedLink: () => void
}

export function useArticleList(opts: UseArticleListOptions): UseArticleList {
    const { sourceId, groupId, searchQuery, pushItemMark, pushSourceRead } = opts
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
            // The "hidden" filter is its own bin (only hidden items); the other
            // filters operate on the normal (non-hidden) view.
            const hidden = filter === "hidden"
            const list = trimmedQuery
                ? await itemsApi.search({
                      query: trimmedQuery,
                      limit: 50,
                      sourceId: sourceId ?? undefined,
                      groupId: groupId ?? undefined,
                      hasRead: filter === "unread" ? false : undefined,
                      starred: filter === "starred" ? true : undefined,
                      hidden,
                  })
                : await itemsApi.list({
                      limit: 50,
                      sourceId: sourceId ?? undefined,
                      groupId: groupId ?? undefined,
                      hasRead: filter === "unread" ? false : undefined,
                      starred: filter === "starred" ? true : undefined,
                      hidden,
                  })
            if (cancelledRef.current) return
            setItems(list)
            // Preserve a still-valid selection across reloads; otherwise clear
            // it (the article overlay opens only on an explicit click).
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
    }, [filter, sourceId, groupId, searchQuery, reloadUnreadCounts])

    React.useEffect(() => {
        cancelledRef.current = false
        loadItems()
        return () => {
            cancelledRef.current = true
        }
    }, [loadItems])

    // Optional auto-select of the first article (off in this app — the overlay
    // opens only on an explicit click). Keyed on items + the flag.
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

    // Re-read the item from current state by iid (the caller may pass a stale
    // snapshot — e.g. captured when a context menu opened — so trusting its
    // hasRead/starred could flip the wrong way and desync unread counts).
    const onToggleReadItem = React.useCallback(
        async (item: Item) => {
            const cur = items?.find(i => i.iid === item.iid) ?? item
            const next = !cur.hasRead
            const delta = next ? -1 : +1
            applyItemPatch(cur.iid, { hasRead: next })
            bumpUnread(cur.sourceId, delta)
            try {
                await itemsApi.markRead(cur.iid, next)
                pushItemMark?.(cur, next ? "read" : "unread")
            } catch (e) {
                applyItemPatch(cur.iid, { hasRead: !next })
                bumpUnread(cur.sourceId, -delta)
                console.error("[useArticleList] markRead failed", e)
            }
        },
        [items, applyItemPatch, bumpUnread, pushItemMark]
    )

    const onToggleStarItem = React.useCallback(
        async (item: Item) => {
            const cur = items?.find(i => i.iid === item.iid) ?? item
            const next = !cur.starred
            applyItemPatch(cur.iid, { starred: next })
            try {
                await itemsApi.setStarred(cur.iid, next)
                pushItemMark?.(cur, next ? "saved" : "unsaved")
            } catch (e) {
                applyItemPatch(cur.iid, { starred: !next })
                console.error("[useArticleList] setStarred failed", e)
            }
        },
        [items, applyItemPatch, pushItemMark]
    )

    const onSetHiddenItem = React.useCallback(
        async (item: Item, hidden: boolean) => {
            const cur = items?.find(i => i.iid === item.iid) ?? item
            // Optimistically drop it from the current view and close the overlay
            // if it was open. Unread counts exclude hidden items, so hiding an
            // unread one decrements its source; unhiding re-adds it.
            setItems(prev => (prev ? prev.filter(i => i.iid !== cur.iid) : prev))
            setSelectedItem(prev => (prev?.iid === cur.iid ? null : prev))
            if (!cur.hasRead) bumpUnread(cur.sourceId, hidden ? -1 : +1)
            try {
                await itemsApi.setHidden(cur.iid, hidden)
            } catch (e) {
                console.error("[useArticleList] setHidden failed", e)
                // Re-sync the list rather than trying to splice it back in place.
                if (!cur.hasRead) bumpUnread(cur.sourceId, hidden ? +1 : -1)
                await loadItems()
            }
        },
        [items, bumpUnread, loadItems]
    )

    const onOpenItem = React.useCallback(
        (item: Item) => {
            setSelectedItem(item)
            const cur = items?.find(i => i.iid === item.iid) ?? item
            if (cur.hasRead) return
            // Optimistically mark read on open; applyItemPatch also updates the
            // just-set selection (same iid) so the toolbar shows the read state.
            applyItemPatch(cur.iid, { hasRead: true })
            bumpUnread(cur.sourceId, -1)
            itemsApi
                .markRead(cur.iid, true)
                .then(() => pushItemMark?.(cur, "read"))
                .catch(e => {
                    applyItemPatch(cur.iid, { hasRead: false })
                    bumpUnread(cur.sourceId, +1)
                    console.error("[useArticleList] mark read on open failed", e)
                })
        },
        [items, applyItemPatch, bumpUnread, pushItemMark]
    )

    const onToggleRead = React.useCallback(async () => {
        if (selectedItem) await onToggleReadItem(selectedItem)
    }, [selectedItem, onToggleReadItem])

    const onToggleStar = React.useCallback(async () => {
        if (selectedItem) await onToggleStarItem(selectedItem)
    }, [selectedItem, onToggleStarItem])

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
        // Push each affected source read on the service in one shot (marks the
        // whole feed read up to now), instead of per item — the original's
        // markAllRead optimization. Best-effort; local marking is authoritative.
        const before = Date.now()
        for (const sid of sourceDeltas.keys()) pushSourceRead?.(sid, before)
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
    }, [items, loadItems, bumpUnread, pushSourceRead])

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
        onOpenItem,
        loadItems,
        reloadUnreadCounts,
        applyItemPatch,
        onToggleRead,
        onToggleStar,
        onToggleReadItem,
        onToggleStarItem,
        onSetHiddenItem,
        onMarkAllRead,
        onSelectNeighbor,
        onOpenSelectedLink,
    }
}
