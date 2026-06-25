import { describe, it, expect } from "vitest"
import { appendCapped, LOG_CAP, type LogEntry } from "./log-store"

function makeEntry(id: string, ts: number): LogEntry {
    return {
        id,
        ts,
        kind: "refresh-success",
        sourceId: 1,
        sourceName: "test",
        outcome: { kind: "notModified" },
        trigger: "manual",
    }
}

describe("appendCapped", () => {
    it("prepends adds to an empty buffer preserving their order", () => {
        const adds = [makeEntry("a", 1), makeEntry("b", 2), makeEntry("c", 3)]
        const out = appendCapped([], adds, 10)
        expect(out.map(e => e.id)).toEqual(["a", "b", "c"])
    })

    it("prepends adds in front of prev, keeping prev relative order", () => {
        const prev = [makeEntry("p1", 10), makeEntry("p2", 9)]
        const adds = [makeEntry("a1", 20), makeEntry("a2", 19)]
        const out = appendCapped(prev, adds, 10)
        expect(out.map(e => e.id)).toEqual(["a1", "a2", "p1", "p2"])
    })

    it("clamps to cap, dropping oldest from the tail of prev", () => {
        const prev = Array.from({ length: LOG_CAP }, (_, i) => makeEntry(`p${i}`, i))
        const adds = [makeEntry("new", 999)]
        const out = appendCapped(prev, adds, LOG_CAP)
        expect(out.length).toBe(LOG_CAP)
        expect(out[0].id).toBe("new")
        expect(out[out.length - 1].id).toBe(`p${LOG_CAP - 2}`)
    })

    it("handles overflow when adds alone exceed cap", () => {
        const prev = [makeEntry("p", 1)]
        const adds = Array.from({ length: 150 }, (_, i) =>
            makeEntry(`a${i}`, 100 + i)
        )
        const out = appendCapped(prev, adds, LOG_CAP)
        expect(out.length).toBe(LOG_CAP)
        expect(out[0].id).toBe("a0")
        expect(out[LOG_CAP - 1].id).toBe(`a${LOG_CAP - 1}`)
    })

    it("returns empty when cap is 0", () => {
        const out = appendCapped(
            [makeEntry("p", 1)],
            [makeEntry("a", 2)],
            0
        )
        expect(out).toEqual([])
    })

    it("is pure: doesnt mutate inputs", () => {
        const prev = [makeEntry("p", 1)]
        const adds = [makeEntry("a", 2)]
        appendCapped(prev, adds, LOG_CAP)
        expect(prev.map(e => e.id)).toEqual(["p"])
        expect(adds.map(e => e.id)).toEqual(["a"])
    })
})
