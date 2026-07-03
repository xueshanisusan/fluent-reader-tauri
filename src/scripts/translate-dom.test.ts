// @vitest-environment jsdom
import { describe, it, expect } from "vitest"
import {
  escapeText,
  unescapeText,
  tokenize,
  validateTokens,
  extractTextNodes,
} from "./translate-dom"

describe("escape/unescape", () => {
  it("round-trips angle brackets and ampersands", () => {
    const s = "5 < 10 & a > b"
    expect(escapeText(s)).toBe("5 &lt; 10 &amp; a &gt; b")
    expect(unescapeText(escapeText(s))).toBe(s)
  })
})

describe("tokenize", () => {
  it("splits placeholders from text", () => {
    expect(tokenize("The <g0>quick</g0> fox <x1/> end")).toEqual([
      { t: "text", v: "The " },
      { t: "open", n: 0 },
      { t: "text", v: "quick" },
      { t: "close", n: 0 },
      { t: "text", v: " fox " },
      { t: "void", n: 1 },
      { t: "text", v: " end" },
    ])
  })

  it("treats a stray < as literal text", () => {
    expect(tokenize("a < b")).toEqual([{ t: "text", v: "a < b" }])
  })
})

describe("validateTokens", () => {
  const ids = (pair: number[], single: number[]) => ({
    pair: new Set(pair),
    single: new Set(single),
  })

  it("accepts a well-formed, complete set", () => {
    expect(
      validateTokens(tokenize("<g0>x</g0><x1/>"), ids([0], [1]))
    ).toBe(true)
  })

  it("accepts proper nesting", () => {
    expect(
      validateTokens(tokenize("<g0>a<g1>b</g1>c</g0>"), ids([0, 1], []))
    ).toBe(true)
  })

  it("rejects crossed nesting", () => {
    expect(
      validateTokens(tokenize("<g0>a<g1>b</g0>c</g1>"), ids([0, 1], []))
    ).toBe(false)
  })

  it("rejects an unclosed tag", () => {
    expect(validateTokens(tokenize("<g0>a"), ids([0], []))).toBe(false)
  })

  it("rejects a missing placeholder", () => {
    expect(validateTokens(tokenize("plain text"), ids([0], []))).toBe(false)
  })

  it("rejects an unknown / extra placeholder", () => {
    expect(
      validateTokens(tokenize("<g0>a</g0><g5>b</g5>"), ids([0], []))
    ).toBe(false)
  })
})

describe("extractTextNodes (block segmentation)", () => {
  it("makes one unit per block with inline placeholders", () => {
    const ex = extractTextNodes(
      `<p>The <a href="http://x">quick brown</a> fox is <b>fast</b>.</p>`
    )
    expect(ex.texts).toEqual([
      "The <g0>quick brown</g0> fox is <g1>fast</g1>.",
    ])
    const html = ex.build(["那只 <g0>敏捷的棕色</g0> 狐狸 <g1>很快</g1>。"])
    expect(html).toContain(`<a href="http://x">敏捷的棕色</a>`)
    expect(html).toContain("<b>很快</b>")
    expect(html).toContain("那只")
  })

  it("emits a unit for each anonymous inline run around block children", () => {
    const ex = extractTextNodes(`<div>hello<p>inner</p>world</div>`)
    expect(ex.texts).toEqual(["hello", "inner", "world"])
  })

  it("skips a block with no translatable text (image only)", () => {
    expect(extractTextNodes(`<p><img src="a.png"></p>`).texts).toEqual([])
  })

  it("preserves a void inline element via <xN/>", () => {
    const ex = extractTextNodes(`<p>See <img src="a.png"> here.</p>`)
    expect(ex.texts).toEqual(["See <x0/> here."])
    const html = ex.build(["请看 <x0/> 这里。"])
    expect(html).toContain(`<img src="a.png">`)
    expect(html).toContain("请看")
  })

  it("escapes literal angle brackets in source text", () => {
    const ex = extractTextNodes(`<p>5 &lt; 10 &amp; more</p>`)
    expect(ex.texts).toEqual(["5 &lt; 10 &amp; more"])
    const html = ex.build(["5 &lt; 10 &amp; 更多"])
    expect(html).toContain("5 &lt; 10 &amp; 更多")
  })

  it("keeps inline tags following reordered content", () => {
    const ex = extractTextNodes(`<p><b>Fast</b> cars</p>`)
    expect(ex.texts).toEqual(["<g0>Fast</g0> cars"])
    // Translation reorders: the wrapped word moves to the end.
    const html = ex.build(["汽车 <g0>很快</g0>"])
    expect(html).toContain("<b>很快</b>")
    expect(html).toContain("汽车")
  })

  it("falls back to plain text when the model drops a placeholder", () => {
    const ex = extractTextNodes(`<p>The <b>bold</b> text.</p>`)
    const html = ex.build(["粗体文本。"]) // <g0> missing → mismatch
    expect(html).toContain("粗体文本。")
    expect(html).not.toContain("<b>")
  })

  it("keeps code spans verbatim (opaque, untranslated)", () => {
    const ex = extractTextNodes(`<p>Run <code>npm install</code> now.</p>`)
    expect(ex.texts).toEqual(["Run <x0/> now."])
    const html = ex.build(["现在运行 <x0/>。"])
    expect(html).toContain("<code>npm install</code>")
  })
})
