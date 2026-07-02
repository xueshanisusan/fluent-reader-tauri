import { describe, it, expect } from "vitest"
import { todayKey, reorderByIds, selectDigest, UNGROUPED_BUCKET } from "./digest"
import type { Item } from "./db-bridge"
import type { DigestConfig } from "./settings-bridge"

function mk(over: Partial<Item> & { iid: number; sourceId: number }): Item {
    return {
        title: `item ${over.iid}`,
        link: `https://e/${over.iid}`,
        dateMs: over.iid, // default: iid doubles as recency for easy ordering
        fetchedDateMs: 0,
        thumb: null,
        content: "",
        snippet: "",
        creator: null,
        hasRead: false,
        starred: false,
        hidden: false,
        notify: false,
        serviceRef: null,
        guid: null,
        ...over,
    }
}

const cfg = (o: Partial<DigestConfig> = {}): DigestConfig => ({
    size: 20,
    base: 2,
    perSource: 2,
    ...o,
})

describe("todayKey", () => {
    it("formats local date as YYYY-MM-DD (not UTC)", () => {
        // Local components, so asserting via a fixed local Date is stable
        // regardless of the runner's timezone.
        const d = new Date(2026, 6, 1, 12, 0, 0) // 2026-07-01 local
        expect(todayKey(d)).toBe("2026-07-01")
    })
    it("zero-pads month and day", () => {
        expect(todayKey(new Date(2026, 0, 5))).toBe("2026-01-05")
    })
})

describe("reorderByIds", () => {
    it("orders items to match the iid sequence", () => {
        const items = [mk({ iid: 1, sourceId: 1 }), mk({ iid: 2, sourceId: 1 }), mk({ iid: 3, sourceId: 1 })]
        expect(reorderByIds(items, [3, 1, 2]).map(i => i.iid)).toEqual([3, 1, 2])
    })
    it("skips iids with no matching item (deleted) and items not in the list", () => {
        const items = [mk({ iid: 1, sourceId: 1 }), mk({ iid: 3, sourceId: 1 })]
        expect(reorderByIds(items, [3, 999, 1]).map(i => i.iid)).toEqual([3, 1])
    })
    it("empty iids → empty", () => {
        expect(reorderByIds([mk({ iid: 1, sourceId: 1 })], [])).toEqual([])
    })
})

describe("selectDigest", () => {
    // group map helper: sid -> gid (or null for ungrouped)
    const groupOf = (map: Record<number, number | null>) => (sid: number) =>
        map[sid] ?? null

    it("returns empty for empty unread or non-positive size", () => {
        expect(selectDigest([], () => null, {}, cfg())).toEqual([])
        expect(
            selectDigest([mk({ iid: 1, sourceId: 1 })], () => null, {}, cfg({ size: 0 }))
        ).toEqual([])
    })

    it("caps per source so one prolific feed can't dominate", () => {
        // 5 items all from source 1; perSource 2 → at most 2 selected.
        const items = [1, 2, 3, 4, 5].map(iid => mk({ iid, sourceId: 1 }))
        const out = selectDigest(items, () => 10, {}, cfg({ perSource: 2 }))
        expect(out.length).toBe(2)
    })

    it("guarantees each group a base before filling (coverage)", () => {
        // group 1 has a flood; group 2 has a single item. base=1 ⇒ group 2's
        // one item must appear even though group 1 is newer/larger.
        const items = [
            mk({ iid: 100, sourceId: 1 }),
            mk({ iid: 101, sourceId: 2 }),
            mk({ iid: 102, sourceId: 3 }),
            mk({ iid: 5, sourceId: 9 }), // lone item in group 2
        ]
        const g = groupOf({ 1: 1, 2: 1, 3: 1, 9: 2 })
        const out = selectDigest(items, g, {}, cfg({ size: 3, base: 1, perSource: 2 }))
        expect(out).toContain(5)
    })

    it("weight steers how many slots each group gets in the fill", () => {
        // Two groups, each with plenty of items (distinct sources to dodge the
        // per-source cap). base=0 so allocation is purely by weight. size=4,
        // weights 3:1 ⇒ group A gets 3, group B gets 1.
        const items = [
            mk({ iid: 1, sourceId: 11 }),
            mk({ iid: 2, sourceId: 12 }),
            mk({ iid: 3, sourceId: 13 }),
            mk({ iid: 4, sourceId: 14 }),
            mk({ iid: 5, sourceId: 21 }),
            mk({ iid: 6, sourceId: 22 }),
            mk({ iid: 7, sourceId: 23 }),
            mk({ iid: 8, sourceId: 24 }),
        ]
        const g = groupOf({ 11: 1, 12: 1, 13: 1, 14: 1, 21: 2, 22: 2, 23: 2, 24: 2 })
        const out = selectDigest(items, g, { 1: 3, 2: 1 }, cfg({ size: 4, base: 0, perSource: 1 }))
        const groupA = out.filter(iid => iid <= 4).length
        const groupB = out.filter(iid => iid >= 5).length
        expect(groupA).toBe(3)
        expect(groupB).toBe(1)
    })

    it("mutes a group with weight <= 0 (no base, no fill)", () => {
        const items = [
            mk({ iid: 1, sourceId: 1 }),
            mk({ iid: 2, sourceId: 2 }),
        ]
        const g = groupOf({ 1: 1, 2: 2 })
        const out = selectDigest(items, g, { 2: 0 }, cfg({ size: 10, base: 2 }))
        expect(out).toContain(1)
        expect(out).not.toContain(2)
    })

    it("prioritizes notify-flagged items within a bucket", () => {
        // Older item is notify-flagged; with base room for 1, it wins over the
        // newer non-flagged one.
        const items = [
            mk({ iid: 50, sourceId: 1, dateMs: 50, notify: false }),
            mk({ iid: 10, sourceId: 1, dateMs: 10, notify: true }),
        ]
        const out = selectDigest(items, () => 1, {}, cfg({ size: 1, base: 1, perSource: 5 }))
        expect(out).toEqual([10])
    })

    it("never exceeds the size budget", () => {
        const items = Array.from({ length: 50 }, (_, k) =>
            mk({ iid: k + 1, sourceId: (k % 10) + 1 })
        )
        const g = groupOf(Object.fromEntries(Array.from({ length: 10 }, (_, k) => [k + 1, (k % 3) + 1])))
        const out = selectDigest(items, g, {}, cfg({ size: 7 }))
        expect(out.length).toBe(7)
        // no duplicates
        expect(new Set(out).size).toBe(out.length)
    })

    it("treats ungrouped sources as one bucket keyed by the sentinel", () => {
        const items = [mk({ iid: 1, sourceId: 1 }), mk({ iid: 2, sourceId: 2 })]
        // Both ungrouped; muting the sentinel bucket removes them all.
        const out = selectDigest(items, () => null, { [UNGROUPED_BUCKET]: 0 }, cfg())
        expect(out).toEqual([])
    })
})
