import * as React from "react"
import { sanitize } from "../../scripts/article-sanitize"
import {
    buildSrcdoc,
    type IframeMessage,
    type HostStyle,
    type ArticleMeta,
} from "./iframe-bootstrap"
import styles from "./ArticleView.module.css"

export interface ArticleViewProps {
    html: string
    articleId?: string | number
    hostStyle?: HostStyle
    // In-article header (title/source/author/date). Tracked by articleId in the
    // srcdoc memo: meta is a pure function of the item, and articleId changes
    // whenever the item does, so it doesn't need its own dep.
    meta?: ArticleMeta
    onLink?: (url: string) => void
    onKey?: (key: string, mods: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean }) => void
    onCtxMenu?: (data: { x: number; y: number; text: string | null; href: string | null }) => void
}

// Imperative handle for the streaming translator: patch one already-rendered
// block in place (no reload). Patches sent before the iframe's bootstrap is
// ready are queued and flushed on the `ready` ping.
export interface ArticleViewHandle {
    patchUnit(i: number, html: string): void
}

function isIframeMessage(d: unknown): d is IframeMessage {
    if (!d || typeof d !== "object") return false
    const t = (d as { t?: unknown }).t
    return t === "ready" || t === "link" || t === "key" || t === "ctxmenu" || t === "scroll"
}

export const ArticleView = React.forwardRef<ArticleViewHandle, ArticleViewProps>(
    function ArticleView(props, ref): React.ReactElement {
        const { html, articleId = "default", hostStyle, meta, onLink, onKey, onCtxMenu } = props
        const iframeRef = React.useRef<HTMLIFrameElement | null>(null)
        // Bootstrap-ready gate + queue for patches that arrive before it.
        const readyRef = React.useRef(false)
        const pendingRef = React.useRef<Array<{ i: number; html: string }>>([])
        // Latest known scroll offset, restored after a same-article srcdoc reload.
        const lastScrollRef = React.useRef(0)

        const srcdoc = React.useMemo<string | null>(() => {
            try {
                return buildSrcdoc(sanitize(html), hostStyle, meta)
            } catch (e) {
                console.error("[ArticleView] sanitize failed", e)
                return null
            }
            // meta is keyed by articleId (see prop doc), so it isn't a separate dep.
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [html, articleId, hostStyle?.fontSize, hostStyle?.fontFamily, hostStyle?.theme])

        // Any new srcdoc means a fresh (not-yet-ready) document; drop queued
        // patches (they belonged to the previous render).
        React.useEffect(() => {
            readyRef.current = false
            pendingRef.current = []
        }, [srcdoc])

        // A different article starts fresh at the top; don't restore a stale offset.
        React.useEffect(() => {
            lastScrollRef.current = 0
        }, [articleId])

        function post(msg: unknown): void {
            iframeRef.current?.contentWindow?.postMessage(msg, "*")
        }

        React.useImperativeHandle(
            ref,
            () => ({
                patchUnit(i: number, patchHtml: string): void {
                    if (readyRef.current) post({ t: "patch", i, html: patchHtml })
                    else pendingRef.current.push({ i, html: patchHtml })
                },
            }),
            []
        )

        React.useEffect(() => {
            function onMessage(e: MessageEvent): void {
                if (e.source !== iframeRef.current?.contentWindow) return
                if (!isIframeMessage(e.data)) {
                    console.warn("[ArticleView] unknown message", e.data)
                    return
                }
                switch (e.data.t) {
                    case "ready":
                        // Bootstrap is up: flush queued patches, then restore scroll
                        // (no-op at 0 for a first load; restores across a reload).
                        readyRef.current = true
                        for (const p of pendingRef.current) post({ t: "patch", i: p.i, html: p.html })
                        pendingRef.current = []
                        post({ t: "setscroll", top: lastScrollRef.current })
                        break
                    case "scroll":
                        lastScrollRef.current = e.data.top
                        break
                    case "link": {
                        // Belt: literal scheme+`//` prefix rejects `https:foo:` protocol-confusion forms
                        // that `new URL(...).protocol === "https:"` would otherwise accept.
                        // Suspenders: Tauri capability `shell:allow-open` glob `https://**` rejects the
                        // same form at the ACL layer if frontend is XSS'd.
                        const url = e.data.url
                        if (!url.startsWith("http://") && !url.startsWith("https://")) {
                            console.warn("[ArticleView] non-http(s) link blocked", url)
                            return
                        }
                        try {
                            new URL(url)
                        } catch {
                            console.warn("[ArticleView] bad link url", url)
                            return
                        }
                        onLink?.(url)
                        break
                    }
                    case "key":
                        onKey?.(e.data.key, e.data.mods)
                        break
                    case "ctxmenu":
                        onCtxMenu?.({ x: e.data.x, y: e.data.y, text: e.data.text, href: e.data.href })
                        break
                }
            }
            window.addEventListener("message", onMessage)
            return () => window.removeEventListener("message", onMessage)
        }, [onLink, onKey, onCtxMenu])

        React.useEffect(() => {
            // Re-arms on any srcdoc churn (article identity, font, theme) — every
            // srcdoc reload re-runs the bootstrap, which posts a `ready` ping; the
            // 5s warning catches the case where the CSP blocks script execution.
            let gotAny = false
            function watch(e: MessageEvent): void {
                if (e.source === iframeRef.current?.contentWindow) gotAny = true
            }
            window.addEventListener("message", watch)
            const tid = window.setTimeout(() => {
                if (!gotAny) console.warn("[ArticleView] no bootstrap message within 5s — script may be blocked by CSP")
            }, 5000)
            return () => {
                window.removeEventListener("message", watch)
                window.clearTimeout(tid)
            }
        }, [articleId, hostStyle?.fontSize, hostStyle?.fontFamily, hostStyle?.theme])

        if (srcdoc === null) {
            return (
                <div className={styles.error}>
                    Couldn't display this article (internal error)
                </div>
            )
        }

        return (
            <iframe
                ref={iframeRef}
                key={articleId}
                sandbox="allow-scripts"
                srcDoc={srcdoc}
                referrerPolicy="no-referrer"
                className={styles.iframe}
                title="article"
            />
        )
    }
)
