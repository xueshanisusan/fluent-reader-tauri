// Bootstrap protocol for the article iframe.
//
// The iframe runs with sandbox="allow-scripts" + sanitized HTML (no feed-supplied
// scripts survive sanitize), so the IFRAME_BOOTSTRAP string below is the *only*
// JS executing inside the iframe. That makes postMessage from inside the iframe
// trustworthy: there is no other code in the same contentWindow that could forge
// these events.

export type IframeMessage =
    | { t: "ready" }
    | { t: "link";    url: string }
    | { t: "key";     key: string; mods: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean } }
    | { t: "ctxmenu"; x: number; y: number; text: string | null; href: string | null }

export const FORWARD_KEYS: readonly string[] = [
    "Escape",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
    "PageDown", "PageUp", "Home", "End",
] as const

export interface HostStyle {
    fontSize: number // px; clamped/sanitized by caller
    fontFamily: string // empty string = use HOST_BASE_CSS default
    theme: "light" | "dark"
}

export const DEFAULT_HOST_STYLE: HostStyle = {
    fontSize: 16,
    fontFamily: "",
    theme: "light",
}

// Dark-mode color tokens for the iframe. Override --fr-fg / --fr-bg /
// --fr-link on :root so the rules in HOST_BASE_CSS (which use these vars
// with light fallbacks) pick the dark values automatically.
const HOST_DARK_OVERRIDE = `
  :root { --fr-fg: #e8e8e8; --fr-bg: #1a1a1a; --fr-link: #6cf; }
  blockquote { color: #aaa; }
  pre { background: #2a2a2a; }
`

export const HOST_BASE_CSS = `
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
    font-size: 16px; line-height: 1.6;
    max-width: 720px; margin: 0 auto; padding: 24px;
    color: var(--fr-fg, #222); background: var(--fr-bg, #fff);
  }
  a { color: var(--fr-link, #06c); }
  img { max-width: 100%; height: auto; }
  blockquote { border-left: 3px solid var(--fr-link, #06c); padding-left: 12px; color: #666; margin-left: 0; }
  pre { background: #f4f4f4; padding: 12px; overflow-x: auto; }
  code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 0.95em; }
`

// Builds a small extra <style> block to override base body font. fontFamily
// is escaped — feed-supplied data never reaches this path, but the settings
// modal *does* accept user-typed fontFamily, so we strip anything that could
// break out of the CSS string. ASCII letters, digits, comma, dash, space,
// quotes, dot, parens — covers "Georgia, serif", '"Source Sans 3", system-ui'.
function buildHostOverride(style: HostStyle): string {
    const size = clamp(style.fontSize, 12, 28)
    const safeFamily = style.fontFamily.replace(/[^A-Za-z0-9 ,\-_'"\.\(\)]/g, "")
    const familyRule = safeFamily.trim()
        ? `body { font-family: ${safeFamily}; }`
        : ""
    const themeRule = style.theme === "dark" ? HOST_DARK_OVERRIDE : ""
    return `${themeRule}\n  body { font-size: ${size}px; }\n  ${familyRule}`
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, Math.round(n)))
}

export const IFRAME_BOOTSTRAP = `
(function(){
  var FORWARD_KEYS = ${JSON.stringify([...FORWARD_KEYS])};
  function post(msg){ try { parent.postMessage(msg, '*'); } catch(e){} }

  // One-shot "I'm alive" ping so the host's watchdog can confirm the bootstrap
  // actually executed without waiting on user input.
  post({t:'ready'});

  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (a && a.href) { e.preventDefault(); post({t:'link', url:a.href}); }
  }, true);

  document.addEventListener('auxclick', function(e){
    if (e.button !== 1) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (a && a.href) { e.preventDefault(); post({t:'link', url:a.href}); }
  }, true);

  document.addEventListener('keydown', function(e){
    if (FORWARD_KEYS.indexOf(e.key) === -1) return;
    post({t:'key', key:e.key, mods:{shift:e.shiftKey, ctrl:e.ctrlKey, alt:e.altKey, meta:e.metaKey}});
  }, true);

  document.addEventListener('contextmenu', function(e){
    e.preventDefault();
    var sel = window.getSelection && window.getSelection();
    var text = sel && sel.toString() ? sel.toString() : null;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    post({t:'ctxmenu', x:e.clientX, y:e.clientY, text:text, href:a?a.href:null});
  }, true);
})();
`

export function buildSrcdoc(
    cleanHtml: string,
    style: HostStyle = DEFAULT_HOST_STYLE
): string {
    return `<!doctype html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="referrer" content="no-referrer">
<style>${HOST_BASE_CSS}${buildHostOverride(style)}</style>
</head><body>
${cleanHtml}
<script>${IFRAME_BOOTSTRAP}</script>
</body></html>`
}
