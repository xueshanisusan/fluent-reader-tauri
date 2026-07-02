import * as React from "react"
import { items as itemsApi, type Item, type Source } from "../../scripts/db-bridge"
import { openExternal } from "../../scripts/shell-bridge"
import { settings } from "../../scripts/settings-bridge"
import { selectDigest, reorderByIds, todayKey } from "../../scripts/digest"
import type { MarkKind } from "../../scripts/service-bridge"

// How many recent unread articles the selection algorithm considers. Bounded so
// a user with a huge backlog still gets a fast, representative pick (the digest
// is "catch the best of the recent unread", not "scan everything").
const CANDIDATE_LIMIT = 1000

export interface UseDigestOptions {
    // The digest only generates/loads while its sidebar entry is selected.
    active: boolean
    // Needed to map a source to its group for the weighted selection.
    sources: Source[]
    // Best-effort push of a local read/star change to the sync service (Fever).
    pushItemMark?: (item: Item, kind: MarkKind) => void
    // Called after a mutation that changes unread counts, so the caller can
    // refresh the sidebar badges (which the digest doesn't own).
    onAfterMutate?: () => void
}

export interface UseDigest {
    items: Item[] | null
    loading: boolean
    error: string | null
    // Total in the frozen digest and how many are still unread ("还剩 M / N").
    total: number
    remaining: number
    selectedItem: Item | null
    setSelectedItem: (it: Item | null) => void
    onOpenItem: (item: Item) => void
    onToggleReadItem: (item: Item) => Promise<void>
    onToggleStarItem: (item: Item) => Promise<void>
    onSetHiddenItem: (item: Item, hidden: boolean) => Promise<void>
    onToggleRead: () => Promise<void>
    onToggleStar: () => Promise<void>
    // Rebuild the digest from scratch (ignores today's frozen snapshot).
    regenerate: () => Promise<void>
}

export function useDigest(opts: UseDigestOptions): UseDigest {
    const { active, sources, pushItemMark, onAfterMutate } = opts
    const [items, setItems] = React.useState<Item[] | null>(null)
    const [loading, setLoading] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)
    const [selectedItem, setSelectedItem] = React.useState<Item | null>(null)

    const cancelledRef = React.useRef(false)
    React.useEffect(() => {
        cancelledRef.current = false
        return () => {
            cancelledRef.current = true
        }
    }, [])

    // Keep sources in a ref so the load callback doesn't re-run every time the
    // sources array identity changes (it's rebuilt on many unrelated updates).
    const sourcesRef = React.useRef<Source[]>(sources)
    React.useEffect(() => {
        sourcesRef.current = sources
    }, [sources])

    const groupOf = React.useCallback((sourceId: number): number | null => {
        const s = sourcesRef.current.find(x => x.sid === sourceId)
        return s ? s.groupId : null
    }, [])

    // Run the selection algorithm over the most recent unread articles.
    const generate = React.useCallback(async (): Promise<number[]> => {
        const [unread, weights, config] = await Promise.all([
            itemsApi.list({ hasRead: false, hidden: false, limit: CANDIDATE_LIMIT }),
            settings.get("digestWeights"),
            settings.get("digestConfig"),
        ])
        return selectDigest(unread, groupOf, weights, config)
    }, [groupOf])

    const loadByIds = React.useCallback(async (iids: number[]) => {
        const fetched = await itemsApi.byIds(iids)
        if (cancelledRef.current) return
        // Backend returns rows unordered; restore the picked sequence. total /
        // remaining derive from what actually came back, so a deleted source
        // shrinks the digest instead of leaving phantom slots.
        setItems(reorderByIds(fetched, iids))
    }, [])

    // Ensure today's frozen snapshot exists (generate + persist if missing or
    // stale), then load its items. `force` rebuilds regardless of the snapshot.
    const build = React.useCallback(
        async (force: boolean) => {
            setLoading(true)
            setError(null)
            try {
                let iids: number[]
                const snap = force ? null : await settings.get("dailyDigest")
                if (snap && snap.date === todayKey()) {
                    iids = snap.iids
                } else {
                    iids = await generate()
                    if (cancelledRef.current) return
                    await settings.set("dailyDigest", { date: todayKey(), iids })
                }
                await loadByIds(iids)
            } catch (e) {
                if (cancelledRef.current) return
                setError(String((e as Error)?.message ?? e))
            } finally {
                if (!cancelledRef.current) setLoading(false)
            }
        },
        [generate, loadByIds]
    )

    // Build once when the digest becomes active (and it hasn't loaded yet).
    const builtRef = React.useRef(false)
    React.useEffect(() => {
        if (!active) {
            builtRef.current = false
            return
        }
        if (builtRef.current) return
        builtRef.current = true
        void build(false)
    }, [active, build])

    const regenerate = React.useCallback(async () => {
        await build(true)
    }, [build])

    const applyItemPatch = React.useCallback(
        (iid: number, patch: Partial<Item>) => {
            setItems(prev =>
                prev ? prev.map(it => (it.iid === iid ? { ...it, ...patch } : it)) : prev
            )
            setSelectedItem(prev =>
                prev && prev.iid === iid ? { ...prev, ...patch } : prev
            )
        },
        []
    )

    const onOpenItem = React.useCallback(
        (item: Item) => {
            setSelectedItem(item)
            if (item.hasRead) return
            // Read items stay in the frozen digest (greyed) so progress is
            // visible — we only flip hasRead, never remove.
            applyItemPatch(item.iid, { hasRead: true })
            itemsApi
                .markRead(item.iid, true)
                .then(() => {
                    pushItemMark?.(item, "read")
                    onAfterMutate?.()
                })
                .catch(e => {
                    applyItemPatch(item.iid, { hasRead: false })
                    console.error("[useDigest] mark read on open failed", e)
                })
        },
        [applyItemPatch, pushItemMark, onAfterMutate]
    )

    const onToggleReadItem = React.useCallback(
        async (item: Item) => {
            const cur = items?.find(i => i.iid === item.iid) ?? item
            const next = !cur.hasRead
            applyItemPatch(cur.iid, { hasRead: next })
            try {
                await itemsApi.markRead(cur.iid, next)
                pushItemMark?.(cur, next ? "read" : "unread")
                onAfterMutate?.()
            } catch (e) {
                applyItemPatch(cur.iid, { hasRead: !next })
                console.error("[useDigest] markRead failed", e)
            }
        },
        [items, applyItemPatch, pushItemMark, onAfterMutate]
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
                console.error("[useDigest] setStarred failed", e)
            }
        },
        [items, applyItemPatch, pushItemMark]
    )

    const onSetHiddenItem = React.useCallback(
        async (item: Item, hidden: boolean) => {
            const cur = items?.find(i => i.iid === item.iid) ?? item
            // Hiding removes it from the digest view (and the overlay).
            setItems(prev => (prev ? prev.filter(i => i.iid !== cur.iid) : prev))
            setSelectedItem(prev => (prev?.iid === cur.iid ? null : prev))
            try {
                await itemsApi.setHidden(cur.iid, hidden)
                onAfterMutate?.()
            } catch (e) {
                console.error("[useDigest] setHidden failed", e)
            }
        },
        [items, onAfterMutate]
    )

    const onToggleRead = React.useCallback(async () => {
        if (selectedItem) await onToggleReadItem(selectedItem)
    }, [selectedItem, onToggleReadItem])

    const onToggleStar = React.useCallback(async () => {
        if (selectedItem) await onToggleStarItem(selectedItem)
    }, [selectedItem, onToggleStarItem])

    const total = items?.length ?? 0
    const remaining = items ? items.filter(i => !i.hasRead).length : 0

    return {
        items,
        loading,
        error,
        total,
        remaining,
        selectedItem,
        setSelectedItem,
        onOpenItem,
        onToggleReadItem,
        onToggleStarItem,
        onSetHiddenItem,
        onToggleRead,
        onToggleStar,
        regenerate,
    }
}

// Small helper the digest header uses for the "open in browser" action, kept
// here so the view doesn't import the shell bridge directly.
export function openDigestLink(url: string): void {
    openExternal(url).catch(err =>
        console.error("[useDigest] openExternal failed", err)
    )
}
