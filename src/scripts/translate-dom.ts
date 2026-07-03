// Extract translatable text from article HTML while preserving structure, then
// rebuild it with translations swapped in. Segmentation is BLOCK-level: each
// maximal run of inline content (a paragraph, a heading, a list item, or a bare
// run of text/inline nodes) becomes ONE translation unit, with inline elements
// (links, bold, images…) replaced by placeholders so the model translates a
// whole sentence in context and we reinsert the formatting afterwards.
//
// Placeholder grammar (the ONLY markup in a unit string): <gN>…</gN> wraps a
// paired inline element; <xN/> is a self-contained one (img/br) or an opaque
// don't-translate element (code). Literal <, >, & in source text are escaped so
// they can't be mistaken for placeholders.
//
// Runs in the webview (DOMParser + DOM). The pure string helpers (escape,
// tokenize, validate) are unit-tested in node; the DOM round-trip is tested
// under jsdom (see translate-dom.test.ts).

// Block-level elements: a run of inline content ends at each of these, and we
// recurse into them for nested units.
const BLOCK_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "DL", "DT", "DD",
  "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH", "CAPTION",
  "COLGROUP", "COL", "FIGURE", "FIGCAPTION", "DIV", "SECTION", "ARTICLE",
  "ASIDE", "HEADER", "FOOTER", "NAV", "MAIN", "ADDRESS", "PRE", "HR",
])
// Self-contained inline elements → <xN/> (cloned whole on rebuild).
const VOID_INLINE = new Set(["BR", "IMG", "WBR"])
// Inline elements whose text must NOT be translated → kept verbatim as <xN/>.
const OPAQUE_TAGS = new Set(["CODE", "KBD", "SAMP", "VAR"])
// Dropped entirely (never survive sanitize anyway).
const DROP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT"])

export interface Extraction {
  // One entry per translation unit (block / inline run), in document order.
  texts: string[]
  // The ORIGINAL article with each unit's container marked data-tr-unit="i".
  // Rendered first for streaming, then patched block-by-block in place.
  taggedHtml: string
  // Reconstruct ONE unit's inner HTML from its translation (read-only; safe to
  // call repeatedly / interleaved). Used for streaming in-place patches.
  buildUnit: (i: number, translated: string) => string
  // Given translations aligned 1:1 with `texts`, return the whole rebuilt HTML
  // (mutates the working doc once). Used for the cache / non-streaming path.
  build: (translations: string[]) => string
}

type Placeholder = { kind: "pair" | "void" | "opaque"; node: Element }

interface Unit {
  parent: Node
  runNodes: Node[]
  text: string
  map: Map<number, Placeholder>
  // True when the run is the entire content of its (non-body) block parent, so
  // we can mark the block itself instead of wrapping the run in a span.
  wholeParent: boolean
  // The element carrying data-tr-unit whose children we replace on patch.
  anchor: Element | null
}

// ---- pure string helpers (node-testable) --------------------------------

export function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function unescapeText(s: string): string {
  // &amp; last so we don't double-decode.
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

export type Token =
  | { t: "text"; v: string }
  | { t: "open"; n: number }
  | { t: "close"; n: number }
  | { t: "void"; n: number }

// Tokenize a (model-produced) unit string against the strict placeholder
// grammar. Anything that isn't an exact <gN>/</gN>/<xN/> token is literal text —
// so a stray "<" the model emitted can't corrupt parsing.
export function tokenize(s: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let buf = ""
  const flush = (): void => {
    if (buf) {
      tokens.push({ t: "text", v: buf })
      buf = ""
    }
  }
  while (i < s.length) {
    if (s[i] === "<") {
      const rest = s.slice(i)
      let m: RegExpExecArray | null
      if ((m = /^<g(\d+)>/.exec(rest))) {
        flush()
        tokens.push({ t: "open", n: Number(m[1]) })
        i += m[0].length
        continue
      }
      if ((m = /^<\/g(\d+)>/.exec(rest))) {
        flush()
        tokens.push({ t: "close", n: Number(m[1]) })
        i += m[0].length
        continue
      }
      if ((m = /^<x(\d+)\/>/.exec(rest))) {
        flush()
        tokens.push({ t: "void", n: Number(m[1]) })
        i += m[0].length
        continue
      }
    }
    buf += s[i++]
  }
  flush()
  return tokens
}

// A translated unit is usable only if its placeholders form a well-formed tree
// (proper nesting, no crossed/unclosed tags) AND cover exactly the recorded set
// (each once, none extra/unknown). Otherwise the caller falls back to plain text.
export function validateTokens(
  tokens: Token[],
  ids: { pair: Set<number>; single: Set<number> }
): boolean {
  const stack: number[] = []
  const seenPair = new Set<number>()
  const seenSingle = new Set<number>()
  for (const tk of tokens) {
    if (tk.t === "open") {
      if (!ids.pair.has(tk.n) || seenPair.has(tk.n)) return false
      seenPair.add(tk.n)
      stack.push(tk.n)
    } else if (tk.t === "close") {
      if (stack.pop() !== tk.n) return false
    } else if (tk.t === "void") {
      if (!ids.single.has(tk.n) || seenSingle.has(tk.n)) return false
      seenSingle.add(tk.n)
    }
  }
  if (stack.length) return false
  return seenPair.size === ids.pair.size && seenSingle.size === ids.single.size
}

function hasTranslatableText(serialized: string): boolean {
  return serialized.replace(/<\/?g\d+>|<x\d+\/>/g, "").trim().length > 0
}

function idSets(map: Map<number, Placeholder>): {
  pair: Set<number>
  single: Set<number>
} {
  const pair = new Set<number>()
  const single = new Set<number>()
  for (const [n, ph] of map) {
    if (ph.kind === "pair") pair.add(n)
    else single.add(n)
  }
  return { pair, single }
}

// ---- DOM walk (webview / jsdom) ------------------------------------------

function serializeRun(nodes: Node[]): {
  text: string
  map: Map<number, Placeholder>
} {
  const map = new Map<number, Placeholder>()
  const out: string[] = []
  let n = 0
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      out.push(escapeText(node.nodeValue ?? ""))
      return
    }
    if (node.nodeType !== 1) return
    const el = node as Element
    const tag = el.tagName
    if (DROP_TAGS.has(tag)) return
    if (VOID_INLINE.has(tag) || OPAQUE_TAGS.has(tag)) {
      const id = n++
      map.set(id, { kind: OPAQUE_TAGS.has(tag) ? "opaque" : "void", node: el })
      out.push(`<x${id}/>`)
      return
    }
    // Paired inline (also the lenient bucket for unexpected inline tags).
    const id = n++
    map.set(id, { kind: "pair", node: el })
    out.push(`<g${id}>`)
    el.childNodes.forEach(walk)
    out.push(`</g${id}>`)
  }
  nodes.forEach(walk)
  return { text: out.join(""), map }
}

function collectUnits(node: Node, units: Unit[]): void {
  let run: Node[] = []
  const flush = (): void => {
    if (run.length === 0) return
    const { text, map } = serializeRun(run)
    if (hasTranslatableText(text)) {
      // Whole-parent iff this run is ALL of a non-body block's children — then
      // we mark the block itself rather than wrap the run in a span (avoids
      // invalid spans in phrasing-unsafe parents). Captured now, before tagging
      // mutates the DOM.
      const wholeParent =
        node.nodeType === 1 &&
        (node as Element).tagName !== "BODY" &&
        run.length === node.childNodes.length
      units.push({ parent: node, runNodes: run, text, map, wholeParent, anchor: null })
    }
    run = []
  }
  node.childNodes.forEach(child => {
    if (child.nodeType === 1 && BLOCK_TAGS.has((child as Element).tagName)) {
      flush()
      collectUnits(child, units)
    } else if (
      child.nodeType === 1 &&
      DROP_TAGS.has((child as Element).tagName)
    ) {
      flush() // boundary; the element itself is left for sanitize to discard
    } else {
      run.push(child)
    }
  })
  flush()
}

function buildNodes(
  tokens: Token[],
  map: Map<number, Placeholder>,
  doc: Document
): Node[] {
  const root = doc.createDocumentFragment()
  const stack: Node[] = [root]
  const top = (): Node => stack[stack.length - 1]
  for (const tk of tokens) {
    if (tk.t === "text") {
      top().appendChild(doc.createTextNode(unescapeText(tk.v)))
    } else if (tk.t === "void") {
      top().appendChild(map.get(tk.n)!.node.cloneNode(true))
    } else if (tk.t === "open") {
      const el = map.get(tk.n)!.node.cloneNode(false) as Element
      top().appendChild(el)
      stack.push(el)
    } else {
      stack.pop()
    }
  }
  return Array.from(root.childNodes)
}

// Build a unit's fresh translated nodes (from clones in its map — READ-ONLY on
// the working doc, so repeated/interleaved calls can't interfere). Falls back to
// plain translated text on any placeholder mismatch.
function unitNodes(unit: Unit, translated: string, doc: Document): Node[] {
  try {
    const tokens = tokenize(translated)
    if (!validateTokens(tokens, idSets(unit.map))) {
      throw new Error("placeholder mismatch")
    }
    return buildNodes(tokens, unit.map, doc)
  } catch {
    const plain = unescapeText(translated.replace(/<\/?g\d+>|<x\d+\/>/g, ""))
    return [doc.createTextNode(plain)]
  }
}

// Serialize detached nodes to an HTML string (for postMessage into the iframe).
function serializeNodes(nodes: Node[], doc: Document): string {
  const tmp = doc.createElement("div")
  for (const n of nodes) tmp.appendChild(n)
  return tmp.innerHTML
}

// Mark each unit's anchor with data-tr-unit: the block element itself when the
// run is its whole content, else a fresh <span> wrapping the run.
function tagUnits(units: Unit[], doc: Document): void {
  units.forEach((u, i) => {
    if (u.wholeParent && u.parent.nodeType === 1) {
      const el = u.parent as Element
      el.setAttribute("data-tr-unit", String(i))
      u.anchor = el
    } else {
      const span = doc.createElement("span")
      span.setAttribute("data-tr-unit", String(i))
      u.parent.insertBefore(span, u.runNodes[0])
      for (const rn of u.runNodes) span.appendChild(rn)
      u.anchor = span
    }
  })
}

export function extractTextNodes(html: string): Extraction {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const units: Unit[] = []
  collectUnits(doc.body, units)
  tagUnits(units, doc)

  return {
    texts: units.map(u => u.text),
    taggedHtml: doc.body.innerHTML,
    buildUnit(i: number, translated: string): string {
      const u = units[i]
      if (!u) return ""
      return serializeNodes(unitNodes(u, translated, doc), doc)
    },
    build(translations: string[]): string {
      if (translations.length !== units.length) {
        throw new Error(
          `translation count ${translations.length} != ${units.length} units`
        )
      }
      try {
        units.forEach((u, i) => {
          if (u.anchor) {
            u.anchor.replaceChildren(...unitNodes(u, translations[i], doc))
          }
        })
        return doc.body.innerHTML
      } catch (e) {
        // Last-resort guard: never corrupt the article — show it untranslated.
        console.error("[translate-dom] rebuild failed; keeping original", e)
        return html
      }
    },
  }
}
