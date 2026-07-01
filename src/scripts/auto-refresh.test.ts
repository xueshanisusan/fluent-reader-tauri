import { describe, it, expect } from "vitest"
import { computeDueSources } from "./auto-refresh"
import type { Source } from "./db-bridge"

function makeSource(over: Partial<Source>): Source {
    return {
        sid: 1,
        url: "https://example.com/feed",
        iconUrl: null,
        name: "test",
        openTarget: 0,
        lastFetchedMs: 0,
        serviceRef: null,
        fetchFrequency: 0,
        textDir: 0,
        hidden: false,
        groupId: null,
        position: 0,
        etag: null,
        lastModified: null,
        ...over,
    }
}

describe("computeDueSources", () => {
    it("returns sources whose fetchFrequency has elapsed since lastFetched", () => {
        const now = 1_000_000_000
        const sources = [
            makeSource({ sid: 1, fetchFrequency: 15, lastFetchedMs: now - 16 * 60_000 }),
            makeSource({ sid: 2, fetchFrequency: 15, lastFetchedMs: now - 14 * 60_000 }),
        ]
        expect(computeDueSources(sources, now)).toEqual([1])
    })

    it("treats fetchFrequency <= 0 as disabled", () => {
        const now = 1_000_000_000
        const sources = [
            makeSource({ sid: 1, fetchFrequency: 0, lastFetchedMs: 0 }),
            makeSource({ sid: 2, fetchFrequency: -5, lastFetchedMs: 0 }),
        ]
        expect(computeDueSources(sources, now)).toEqual([])
    })

    it("skips spike:// demo sources even if otherwise due", () => {
        const now = 1_000_000_000
        const sources = [
            makeSource({
                sid: 1,
                url: "spike://demo",
                fetchFrequency: 15,
                lastFetchedMs: 0,
            }),
        ]
        expect(computeDueSources(sources, now)).toEqual([])
    })

    it("excludes remote (serviceRef != null) sources even if otherwise due", () => {
        const now = 1_000_000_000
        const sources = [
            makeSource({
                sid: 1,
                serviceRef: "42",
                fetchFrequency: 15,
                lastFetchedMs: 0,
            }),
            makeSource({
                sid: 2,
                serviceRef: null,
                fetchFrequency: 15,
                lastFetchedMs: 0,
            }),
        ]
        expect(computeDueSources(sources, now)).toEqual([2])
    })

    it("includes sources with lastFetchedMs == 0 (never fetched)", () => {
        const now = 1_000_000_000
        const sources = [
            makeSource({ sid: 7, fetchFrequency: 60, lastFetchedMs: 0 }),
        ]
        expect(computeDueSources(sources, now)).toEqual([7])
    })

    it("uses minutes for fetchFrequency (15min = 900_000ms)", () => {
        const now = 1_000_000_000
        // Exactly at threshold qualifies.
        const sources = [
            makeSource({
                sid: 1,
                fetchFrequency: 15,
                lastFetchedMs: now - 15 * 60_000,
            }),
        ]
        expect(computeDueSources(sources, now)).toEqual([1])
    })
})
