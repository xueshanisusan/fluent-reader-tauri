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
    // Throttled scroll report so the host can restore scroll after a srcdoc reload.
    | { t: "scroll";  top: number }

// Host → iframe messages (the streaming translator patches blocks in place and
// restores scroll after the one tagged-original reload).
export type HostMessage =
    | { t: "patch"; i: number; html: string }
    | { t: "setscroll"; top: number }

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

// Header injected at the top of the article body (title + source/author/date),
// matching the original Fluent Reader's in-article header. All fields are
// host-supplied plain strings (DB columns), so they're HTML-escaped before
// interpolation; the title links to the article only when it's an http(s) URL.
export interface ArticleMeta {
    title: string
    link: string
    dateText: string
    sourceName: string
    creator: string | null
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
  :root { --fr-fg: #e8e8e8; --fr-bg: #1a1a1a; --fr-link: #6cf; --fr-muted: #999; --fr-border: #333; }
  blockquote { color: #aaa; }
  pre { background: #2a2a2a; }
`

export const HOST_BASE_CSS = `
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; min-height: 100%; }
  html { background: var(--fr-bg, #fff); }
  body {
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
    font-size: 16px; line-height: 1.6;
    padding: 24px 32px;
    color: var(--fr-fg, #222); background: var(--fr-bg, #fff);
  }
  a { color: var(--fr-link, #06c); }
  img { max-width: 100%; height: auto; }
  p { margin: 0 0 1em; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; font-weight: 600; margin: 1.4em 0 0.5em; }
  h1 { font-size: 1.5em; }
  h2 { font-size: 1.3em; }
  h3 { font-size: 1.15em; }
  h4, h5, h6 { font-size: 1em; }
  ul, ol { padding-left: 1.5em; margin: 0 0 1em; }
  li { margin: 0.25em 0; }
  figure { margin: 1em 0; text-align: center; }
  figure img { margin: 0 auto; }
  figcaption { font-size: 0.85em; color: var(--fr-muted, #888); margin-top: 6px; }
  hr { border: none; border-top: 1px solid var(--fr-border, #ddd); margin: 1.5em 0; }
  table { border-collapse: collapse; max-width: 100%; margin: 1em 0; }
  th, td { border: 1px solid var(--fr-border, #ddd); padding: 6px 10px; text-align: left; }
  blockquote { border-left: 3px solid var(--fr-link, #06c); padding-left: 12px; color: #666; margin: 0 0 1em; }
  pre { background: #f4f4f4; padding: 12px; overflow-x: auto; }
  code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 0.95em; }
  .fr-article-header { border-bottom: 1px solid var(--fr-border, #eee); padding-bottom: 16px; margin-bottom: 20px; }
  .fr-title { font-size: 1.7em; line-height: 1.25; font-weight: 600; margin: 0 0 8px; }
  .fr-title a { color: inherit; text-decoration: none; }
  .fr-title a:hover { text-decoration: underline; }
  .fr-meta { font-size: 0.8em; color: var(--fr-muted, #888); margin: 0; }
  @media (prefers-reduced-motion: no-preference) {
    .fr-tr-in { animation: fr-tr-fade 160ms ease-out; }
  }
  @keyframes fr-tr-fade { from { opacity: 0.35; } to { opacity: 1; } }
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

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

function isHttpUrl(u: string): boolean {
    return /^https?:\/\//i.test(u)
}

// Builds the in-article header HTML. Title is a link only for http(s) URLs
// (escapeHtml can't neutralize a `javascript:` href on its own); clicks route
// through the bootstrap link handler like any other article link. The meta
// line joins the non-empty of source / author / date.
function buildHeader(meta: ArticleMeta): string {
    const titleText = escapeHtml(meta.title)
    const title = isHttpUrl(meta.link)
        ? `<a href="${escapeHtml(meta.link)}">${titleText}</a>`
        : titleText
    const bits = [meta.sourceName, meta.creator ?? "", meta.dateText]
        .filter(s => s.trim() !== "")
        .map(escapeHtml)
        .join(" • ")
    const metaLine = bits ? `<p class="fr-meta">${bits}</p>` : ""
    return `<header class="fr-article-header"><h1 class="fr-title">${title}</h1>${metaLine}</header>`
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

  function scrollTop(){ return (document.scrollingElement||document.documentElement||document.body).scrollTop; }

  // Throttled scroll report so the host can restore position after the one
  // tagged-original reload that starts streaming translation.
  var stTimer = null;
  window.addEventListener('scroll', function(){
    if (stTimer) return;
    stTimer = setTimeout(function(){ stTimer=null; post({t:'scroll', top:scrollTop()}); }, 200);
  }, {passive:true});

  // Host → iframe: patch a translated block in place, or restore scroll. Only
  // the host (parent) can send these; the html is already sanitized host-side,
  // and innerHTML never executes <script>.
  window.addEventListener('message', function(e){
    if (e.source !== parent) return;
    var d = e.data; if (!d) return;
    if (d.t === 'patch') {
      var el = document.querySelector('[data-tr-unit="' + d.i + '"]');
      if (el) { el.innerHTML = d.html; el.classList.add('fr-tr-in'); }
    } else if (d.t === 'setscroll') {
      try { window.scrollTo(0, d.top || 0); } catch(_){}
    }
  }, false);
})();
`

export function buildSrcdoc(
    cleanHtml: string,
    style: HostStyle = DEFAULT_HOST_STYLE,
    meta?: ArticleMeta
): string {
    const header = meta ? buildHeader(meta) : ""
    return `<!doctype html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="referrer" content="no-referrer">
<style>${HOST_BASE_CSS}${buildHostOverride(style)}</style>
</head><body>
${header}${cleanHtml}
<script>${IFRAME_BOOTSTRAP}</script>
</body></html>`
}
