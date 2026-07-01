import { describe, it, expect } from "vitest"
import {
    isFeverActive,
    SyncService,
    type ServiceConfigs,
    type FeverConfigs,
} from "./settings-bridge"

function fever(over: Partial<FeverConfigs>): ServiceConfigs {
    return {
        type: SyncService.Fever,
        endpoint: "https://rss.example.com/api/fever.php",
        username: "user",
        fetchLimit: 250,
        ...over,
    }
}

describe("isFeverActive", () => {
    it("returns null for null/undefined config", () => {
        expect(isFeverActive(null)).toBeNull()
        expect(isFeverActive(undefined)).toBeNull()
    })

    it("returns null when no service is configured", () => {
        expect(isFeverActive({ type: SyncService.None })).toBeNull()
    })

    it("returns null for a non-Fever service", () => {
        expect(isFeverActive({ type: SyncService.Miniflux })).toBeNull()
    })

    it("returns the endpoint for an active Fever service", () => {
        const cfg = fever({ endpoint: "https://rss.example.com/api/fever.php" })
        expect(isFeverActive(cfg)).toBe("https://rss.example.com/api/fever.php")
    })

    it("trims surrounding whitespace on the endpoint", () => {
        const cfg = fever({ endpoint: "  https://rss.example.com/  " })
        expect(isFeverActive(cfg)).toBe("https://rss.example.com/")
    })

    it("returns null for a Fever service with an empty/whitespace endpoint", () => {
        expect(isFeverActive(fever({ endpoint: "" }))).toBeNull()
        expect(isFeverActive(fever({ endpoint: "   " }))).toBeNull()
    })

    it("returns null when the Fever endpoint is missing", () => {
        const cfg: ServiceConfigs = {
            type: SyncService.Fever,
            username: "user",
            fetchLimit: 250,
        }
        expect(isFeverActive(cfg)).toBeNull()
    })
})
