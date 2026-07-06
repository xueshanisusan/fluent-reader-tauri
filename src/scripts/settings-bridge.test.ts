import { describe, it, expect } from "vitest"
import {
    isFeverActive,
    normalizeTranslationConfig,
    TranslateProvider,
    SyncService,
    type ServiceConfigs,
    type FeverConfigs,
    type TranslationConfig,
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

describe("normalizeTranslationConfig", () => {
    const base = (over: Partial<TranslationConfig>): TranslationConfig => ({
        enabled: false,
        provider: TranslateProvider.ManagedLocal,
        endpoint: "",
        model: "",
        targetLang: "",
        targets: [],
        ...over,
    })

    it("migrates a legacy targetLang into a single target", () => {
        // A 2b config had no `targets`; the field is missing on the stored blob.
        const cfg = base({ targetLang: "简体中文" })
        delete (cfg as Partial<TranslationConfig>).targets
        const out = normalizeTranslationConfig(cfg as TranslationConfig)
        expect(out.targets).toEqual([{ lang: "简体中文", modelId: "" }])
        expect(out.targetLang).toBe("简体中文")
    })

    it("keeps targetLang in sync with the first target", () => {
        const out = normalizeTranslationConfig(
            base({
                targetLang: "stale",
                targets: [
                    { lang: "English", modelId: "m1" },
                    { lang: "日本語", modelId: "" },
                ],
            })
        )
        expect(out.targetLang).toBe("English")
    })

    it("drops blank languages and deduplicates by language", () => {
        const out = normalizeTranslationConfig(
            base({
                targets: [
                    { lang: " English ", modelId: "m1" },
                    { lang: "", modelId: "x" },
                    { lang: "English", modelId: "m2" }, // dup lang → first wins
                ],
            })
        )
        expect(out.targets).toEqual([{ lang: "English", modelId: "m1" }])
    })

    it("is idempotent", () => {
        const once = normalizeTranslationConfig(
            base({ targetLang: "English" })
        )
        expect(normalizeTranslationConfig(once)).toEqual(once)
    })
})
