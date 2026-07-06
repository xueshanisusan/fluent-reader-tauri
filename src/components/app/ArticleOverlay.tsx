import * as React from "react"
import type { Item } from "../../scripts/db-bridge"
import type { HostStyle, ArticleMeta } from "../article/iframe-bootstrap"
import type { TranslationConfig } from "../../scripts/settings-bridge"
import { TranslateProvider } from "../../scripts/settings-bridge"
import {
    translate,
    describeTranslationError,
} from "../../scripts/translate-bridge"
import { model } from "../../scripts/model-bridge"
import { extractTextNodes } from "../../scripts/translate-dom"
import { sanitize } from "../../scripts/article-sanitize"
import { ArticleView, type ArticleViewHandle } from "../article/ArticleView"
import { ArticleToolbar } from "./ArticleToolbar"
import { formatArticleDate } from "../../scripts/format"
import styles from "./ArticleOverlay.module.css"

// Session cache of translated article HTML, keyed by `${iid}:${lang}`. Survives
// reopening an article within a session (cleared on restart), bounded so a long
// reading session can't grow it without limit (simple LRU by insertion order).
const TRANSLATION_CACHE_CAP = 50
const translationCache = new Map<string, string>()
function cacheGet(key: string): string | undefined {
    const v = translationCache.get(key)
    if (v !== undefined) {
        translationCache.delete(key)
        translationCache.set(key, v) // bump to most-recent
    }
    return v
}
function cacheSet(key: string, html: string): void {
    translationCache.set(key, html)
    while (translationCache.size > TRANSLATION_CACHE_CAP) {
        const oldest = translationCache.keys().next().value
        if (oldest === undefined) break
        translationCache.delete(oldest)
    }
}

export interface ArticleOverlayProps {
    item: Item
    hostStyle: HostStyle
    articleId: string
    // Source display name + favicon for the header (meta line + toolbar).
    sourceName?: string
    iconUrl?: string | null
    // When false (a modal/search overlay is open above this), the overlay must
    // NOT handle Esc — otherwise one keystroke closes both the modal and the
    // article. The modal owns Esc in that case.
    escEnabled: boolean
    onClose: () => void
    onToggleRead: () => void
    onToggleStar: () => void
    onToggleHidden: () => void
    onOpenInBrowser: () => void
    onLink: (url: string) => void
    onKey: (key: string) => void
    onCtxMenu: (d: {
        x: number
        y: number
        text: string | null
        href: string | null
    }) => void
    // Translation provider config (null/disabled → no Translate button).
    translationConfig?: TranslationConfig
}

export function ArticleOverlay(props: ArticleOverlayProps): React.ReactElement {
    const {
        item,
        hostStyle,
        articleId,
        sourceName,
        iconUrl,
        escEnabled,
        onClose,
        onToggleRead,
        onToggleStar,
        onToggleHidden,
        onOpenInBrowser,
        onLink,
        onKey,
        onCtxMenu,
        translationConfig,
    } = props

    const translateEnabled = !!translationConfig?.enabled
    const targetLang = translationConfig?.targetLang?.trim() ?? ""
    const targets = translationConfig?.targets ?? []
    // Per-article target-language pick (kept across articles as a reading-session
    // preference). Resolve by lang against the CURRENT targets so a settings edit
    // that removes the picked language falls back to the default, never crashes.
    const [pickedLang, setPickedLang] = React.useState("")
    const currentLang =
        pickedLang && targets.some(t => t.lang === pickedLang)
            ? pickedLang
            : targetLang
    // The managed model this language routes to ("" = use the active model).
    const routedModelId =
        targets.find(t => t.lang === currentLang)?.modelId ?? ""
    const [translating, setTranslating] = React.useState(false)
    const [translated, setTranslated] = React.useState(false)
    const [transError, setTransError] = React.useState<string | null>(null)
    const [translatedHtml, setTranslatedHtml] = React.useState<string | null>(
        null
    )
    // Model cold-start (indeterminate) vs per-batch translation progress.
    const [translateStarting, setTranslateStarting] = React.useState(false)
    const [translateProgress, setTranslateProgress] =
        React.useState<{ done: number; total: number } | null>(null)
    // Handle to patch translated blocks into the iframe in place; a session id
    // to drop stale patches after toggle-off / article change.
    const articleViewRef = React.useRef<ArticleViewHandle>(null)
    const streamIdRef = React.useRef(0)

    // Live iid for the stale-result guard: this overlay instance is reused
    // across articles, so a translate call started for one article must not
    // apply its result once the user has moved to another.
    const iidRef = React.useRef(item.iid)
    iidRef.current = item.iid

    // Reset translation state whenever the article changes.
    React.useEffect(() => {
        setTranslating(false)
        setTranslated(false)
        setTransError(null)
        setTranslatedHtml(null)
        setTranslateStarting(false)
        setTranslateProgress(null)
        streamIdRef.current++ // invalidate any in-flight stream for the old article
    }, [item.iid])

    // Drive the determinate bar width imperatively (a dynamic width can't be a
    // static CSS-module class, and inline style objects are disallowed).
    const fillRef = React.useRef<HTMLDivElement>(null)
    React.useEffect(() => {
        const el = fillRef.current
        if (!el) return
        const pct =
            translateProgress && translateProgress.total > 0
                ? Math.round(
                      (translateProgress.done / translateProgress.total) * 100
                  )
                : 0
        el.style.width = `${pct}%`
    }, [translateProgress])

    // Translate the current article into `lang`, routing to `modelId` ("" = the
    // active model). Streams blocks into the iframe in place. Used by both the
    // Translate toggle and the target-language picker (which re-translates).
    const startTranslation = React.useCallback(
        (lang: string, modelId: string) => {
            if (!translationConfig?.enabled) return
            if (!lang) {
                setTransError("Set a target language in Translation settings.")
                return
            }
            const key = `${item.iid}:${lang}`
            const cached = cacheGet(key)
            if (cached !== undefined) {
                streamIdRef.current++ // cancel any in-flight stream
                setTranslatedHtml(cached)
                setTranslated(true)
                setTranslating(false)
                setTranslateStarting(false)
                setTranslateProgress(null)
                setTransError(null)
                return
            }

            const iid0 = item.iid
            const html0 = item.content
            const myStream = ++streamIdRef.current
            setTransError(null)

            const extraction = extractTextNodes(html0)
            if (extraction.texts.length === 0) {
                setTranslatedHtml(html0)
                setTranslated(true)
                return
            }
            // Show the tagged original NOW (one reload); each block is patched in
            // place as it finishes, so the reader can start immediately.
            setTranslatedHtml(extraction.taggedHtml)
            setTranslated(true)
            setTranslating(true)
            setTranslateStarting(true)
            setTranslateProgress({ done: 0, total: extraction.texts.length })

            const live = (): boolean =>
                iidRef.current === iid0 && streamIdRef.current === myStream

            void (async () => {
                try {
                    // ManagedLocal: app owns the runtime — start it (idempotent)
                    // for the routed model and use its ephemeral endpoint. The
                    // cold model load is the indeterminate "preparing" phase.
                    let endpoint = translationConfig.endpoint
                    let modelName = translationConfig.model
                    if (
                        translationConfig.provider ===
                        TranslateProvider.ManagedLocal
                    ) {
                        endpoint = await model.runtimeStart(modelId || undefined)
                        if (!live()) return
                        modelName = modelName || "local"
                    }
                    if (live()) setTranslateStarting(false)

                    const translations = await translate.segments(
                        endpoint,
                        modelName,
                        lang,
                        extraction.texts,
                        p => {
                            if (!live()) return
                            setTranslateProgress({ done: p.done, total: p.total })
                            for (const it of p.items) {
                                articleViewRef.current?.patchUnit(
                                    it.index,
                                    sanitize(
                                        extraction.buildUnit(it.index, it.text)
                                    )
                                )
                            }
                        }
                    )
                    // Cache the whole translation for an instant re-open; the
                    // iframe is already patched, so we DON'T swap html (no reload).
                    if (
                        iidRef.current === iid0 &&
                        translations.length === extraction.texts.length
                    ) {
                        cacheSet(key, extraction.build(translations))
                    }
                } catch (e) {
                    if (live()) {
                        setTransError(
                            "Translation failed: " + describeTranslationError(e)
                        )
                    }
                } finally {
                    if (streamIdRef.current === myStream) {
                        setTranslating(false)
                        setTranslateStarting(false)
                        setTranslateProgress(null)
                    }
                }
            })()
        },
        [translationConfig, item.iid, item.content]
    )

    const onToggleTranslate = React.useCallback(() => {
        if (!translationConfig?.enabled) return
        if (translated) {
            // Toggle off — or cancel an in-flight stream — back to original.
            streamIdRef.current++ // drop any in-flight patches
            setTranslated(false)
            setTranslating(false)
            setTranslateStarting(false)
            setTranslateProgress(null)
            return
        }
        startTranslation(currentLang, routedModelId)
    }, [translationConfig, translated, currentLang, routedModelId, startTranslation])

    // Picking a different target language re-translates into it (unless we're on
    // the original, in which case it just becomes the next Translate target).
    const onPickTarget = React.useCallback(
        (lang: string) => {
            setPickedLang(lang)
            if (translated) {
                const modelId =
                    targets.find(t => t.lang === lang)?.modelId ?? ""
                startTranslation(lang, modelId)
            }
        },
        [translated, targets, startTranslation]
    )

    const displayHtml =
        translated && translatedHtml !== null ? translatedHtml : item.content

    const meta: ArticleMeta = {
        title: item.title,
        link: item.link,
        dateText: formatArticleDate(item.dateMs),
        sourceName: sourceName ?? "",
        creator: item.creator,
    }

    React.useEffect(() => {
        if (!escEnabled) return
        function onKeyDown(e: KeyboardEvent): void {
            if (e.key === "Escape") {
                e.preventDefault()
                onClose()
            }
        }
        window.addEventListener("keydown", onKeyDown)
        return () => window.removeEventListener("keydown", onKeyDown)
    }, [escEnabled, onClose])

    return (
        <div
            className={styles.backdrop}
            onClick={e => {
                // Close only when the dimmed backdrop itself is clicked, not the
                // card (or a drag that ends on it).
                if (e.target === e.currentTarget) onClose()
            }}>
            <div className={styles.card}>
                <ArticleToolbar
                    item={item}
                    sourceName={sourceName}
                    iconUrl={iconUrl}
                    onToggleRead={onToggleRead}
                    onToggleStar={onToggleStar}
                    onToggleHidden={onToggleHidden}
                    onOpenInBrowser={onOpenInBrowser}
                    onClose={onClose}
                    translateEnabled={translateEnabled}
                    translating={translating}
                    translated={translated}
                    onToggleTranslate={onToggleTranslate}
                    translateTargets={targets}
                    currentLang={currentLang}
                    onPickTarget={onPickTarget}
                />
                {translating && translated && (
                    <div className={styles.transProgress}>
                        <div className={styles.transBarTrack}>
                            {translateStarting || !translateProgress ? (
                                <div className={styles.transBarIndeterminate} />
                            ) : (
                                <div
                                    ref={fillRef}
                                    className={styles.transBarFill}
                                />
                            )}
                        </div>
                        <span className={styles.transProgressLabel}>
                            {translateStarting || !translateProgress
                                ? "Preparing model (first time is slow)…"
                                : `Translating ${translateProgress.done}/${translateProgress.total}`}
                        </span>
                    </div>
                )}
                {transError && (
                    <div className={styles.transError} role="alert">
                        {transError}
                    </div>
                )}
                <div className={styles.viewport}>
                    <ArticleView
                        ref={articleViewRef}
                        key={articleId}
                        html={displayHtml}
                        articleId={articleId}
                        hostStyle={hostStyle}
                        meta={meta}
                        onLink={onLink}
                        onKey={onKey}
                        onCtxMenu={onCtxMenu}
                    />
                </div>
            </div>
        </div>
    )
}
