import * as React from "react"
import { items as itemsApi, type Item } from "../../scripts/db-bridge"
import { openExternal } from "../../scripts/shell-bridge"

export type Filter = "all" | "unread" | "starred"

export interface UseArticleList {
    items: Item[] | null
    listLoading: boolean
    listError: string | null
    filter: Filter
    selectedItem: Item | null
    setFilter: (f: Filter) => void
    setSelectedItem: (it: Item | null) => void
    loadItems: () => Promise<void>
    applyItemPatch: (iid: number, patch: Partial<Item>) => void
    onToggleRead: () => Promise<void>
    onToggleStar: () => Promise<void>
    onMarkAllRead: () => Promise<void>
    onSelectNeighbor: (offset: number) => void
    onOpenSelectedLink: () => void
}

export function useArticleList(): UseArticleList {
    const [items, setItems] = React.useState<Item[] | null>(null)
    const [selectedItem, setSelectedItem] = React.useState<Item | null>(null)
    const [listLoading, setListLoading] = React.useState(false)
    const [listError, setListError] = React.useState<string | null>(null)
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
        applyItemPatch(selectedItem.iid, { hasRead: next })
        try {
            await itemsApi.markRead(selectedItem.iid, next)
        } catch (e) {
            applyItemPatch(selectedItem.iid, { hasRead: !next })
            console.error("[useArticleList] markRead failed", e)
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
            console.error("[useArticleList] setStarred failed", e)
        }
    }, [selectedItem, applyItemPatch])

    const onMarkAllRead = React.useCallback(async () => {
        if (!items) return
        const unread = items.filter(i => !i.hasRead)
        if (unread.length === 0) return
        setItems(prev =>
            prev ? prev.map(it => ({ ...it, hasRead: true })) : prev
        )
        setSelectedItem(prev => (prev ? { ...prev, hasRead: true } : prev))
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
    }, [items, loadItems])

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
        setFilter,
        setSelectedItem,
        loadItems,
        applyItemPatch,
        onToggleRead,
        onToggleStar,
        onMarkAllRead,
        onSelectNeighbor,
        onOpenSelectedLink,
    }
}
