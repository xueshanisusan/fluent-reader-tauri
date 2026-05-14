import { describe, it, expect } from "vitest"
import { sanitize } from "./article-sanitize"

describe("article-sanitize", () => {
    it("strips <script>", () => {
        expect(sanitize('<p>hi</p><script>alert(1)</script>')).not.toContain("<script")
    })

    it("strips <svg> (mXSS surface)", () => {
        expect(sanitize('<svg onload="alert(1)"><circle/></svg>')).not.toContain("<svg")
    })

    it("strips <math> (mXSS surface)", () => {
        expect(sanitize('<math><mi>x</mi></math>')).not.toContain("<math")
    })

    it("strips javascript: href", () => {
        const out = sanitize('<a href="javascript:alert(1)">x</a>')
        expect(out).not.toMatch(/href\s*=\s*["']?javascript:/i)
    })

    it("preserves https href on <a> and injects rel", () => {
        const out = sanitize('<a href="https://example.com">x</a>')
        expect(out).toMatch(/href\s*=\s*["']https:\/\/example\.com["']/)
        expect(out).toMatch(/rel\s*=\s*["']noopener noreferrer["']/)
    })

    it("strips background in style but keeps allowed color", () => {
        const out = sanitize('<div style="background:url(https://evil/p);color:red">x</div>')
        expect(out).not.toContain("background")
        expect(out).toContain("color")
    })
})
