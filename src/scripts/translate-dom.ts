// Extract translatable text from article HTML while preserving structure, then
// rebuild the HTML with translations swapped in. Only visible text nodes are
// touched — links, images, and layout are untouched, so the translated article
// renders identically apart from the words. Runs in the webview (DOMParser +
// TreeWalker); not unit-tested here because the node-env test runner has no DOM.

// Elements whose text should NOT be translated (code/markup, not prose).
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE"]);

export interface Extraction {
  // One entry per translatable text node, in document order.
  texts: string[];
  // Given translations aligned 1:1 with `texts`, return the rebuilt HTML.
  build: (translations: string[]) => string;
}

function inSkippedElement(node: Node): boolean {
  let p: Element | null = node.parentElement;
  while (p) {
    if (SKIP_TAGS.has(p.tagName)) return true;
    p = p.parentElement;
  }
  return false;
}

export function extractTextNodes(html: string): Extraction {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const texts: string[] = [];

  let cur = walker.nextNode();
  while (cur) {
    const t = cur as Text;
    const val = t.nodeValue ?? "";
    // Skip whitespace-only nodes and text inside code/markup elements.
    if (val.trim().length > 0 && !inSkippedElement(t)) {
      nodes.push(t);
      texts.push(val);
    }
    cur = walker.nextNode();
  }

  return {
    texts,
    build(translations: string[]): string {
      // Caller guarantees alignment; guard anyway so a mismatch can't corrupt
      // the article by shifting text into the wrong nodes.
      if (translations.length !== nodes.length) {
        throw new Error(
          `translation count ${translations.length} != ${nodes.length} text nodes`
        );
      }
      for (let i = 0; i < nodes.length; i++) {
        nodes[i].nodeValue = translations[i];
      }
      return doc.body.innerHTML;
    },
  };
}
