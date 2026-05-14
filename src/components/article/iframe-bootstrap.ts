// Bootstrap protocol for the article iframe.
//
// The iframe runs with sandbox="allow-scripts" + sanitized HTML (no feed-supplied
// scripts survive sanitize), so the IFRAME_BOOTSTRAP string below is the *only*
// JS executing inside the iframe. That makes postMessage from inside the iframe
// trustworthy: there is no other code in the same contentWindow that could forge
// these events.

export type IframeMessage =
    | { t: "link";    url: string }
    | { t: "key";     key: string; mods: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean } }
    | { t: "ctxmenu"; x: number; y: number; text: string | null; href: string | null }

export const FORWARD_KEYS: readonly string[] = [
    "Escape",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
    "PageDown", "PageUp", "Home", "End",
] as const

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

export const IFRAME_BOOTSTRAP = `
(function(){
  var FORWARD_KEYS = ${JSON.stringify([...FORWARD_KEYS])};
  function post(msg){ try { parent.postMessage(msg, '*'); } catch(e){} }

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

export function buildSrcdoc(cleanHtml: string): string {
    return `<!doctype html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="referrer" content="no-referrer">
<style>${HOST_BASE_CSS}</style>
</head><body>
${cleanHtml}
<script>${IFRAME_BOOTSTRAP}</script>
</body></html>`
}
