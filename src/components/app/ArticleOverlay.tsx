import * as React from "react"
import type { Item } from "../../scripts/db-bridge"
import type { HostStyle, ArticleMeta } from "../article/iframe-bootstrap"
import type { TranslationConfig } from "../../scripts/settings-bridge"
import {
    translate,
    describeTranslationError,
} from "../../scripts/translate-bridge"
import { extractTextNodes } from "../../scripts/translate-dom"
import { ArticleView } from "../article/ArticleView"
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
    const [translating, setTranslating] = React.useState(false)
    const [translated, setTranslated] = React.useState(false)
    const [transError, setTransError] = React.useState<string | null>(null)
    const [translatedHtml, setTranslatedHtml] = React.useState<string | null>(
        null
    )

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
    }, [item.iid])

    const onToggleTranslate = React.useCallback(() => {
        if (!translationConfig?.enabled) return
        if (translated) {
            setTranslated(false) // back to original
            return
        }
        if (!targetLang) {
            setTransError("Set a target language in Translation settings.")
            return
        }
        const key = `${item.iid}:${targetLang}`
        const cached = cacheGet(key)
        if (cached !== undefined) {
            setTranslatedHtml(cached)
            setTranslated(true)
            setTransError(null)
            return
        }
        const iid0 = item.iid
        const html0 = item.content
        setTranslating(true)
        setTransError(null)
        void (async () => {
            try {
                const extraction = extractTextNodes(html0)
                if (extraction.texts.length === 0) {
                    if (iidRef.current === iid0) {
                        setTranslatedHtml(html0)
                        setTranslated(true)
                    }
                    return
                }
                const translations = await translate.segments(
                    translationConfig.endpoint,
                    translationConfig.model,
                    targetLang,
                    extraction.texts
                )
                if (iidRef.current !== iid0) return // article changed — drop
                if (translations.length !== extraction.texts.length) {
                    setTransError("Translation failed (segment count mismatch).")
                    return
                }
                const out = extraction.build(translations)
                cacheSet(key, out)
                setTranslatedHtml(out)
                setTranslated(true)
            } catch (e) {
                if (iidRef.current !== iid0) return
                setTransError(
                    "Translation failed: " + describeTranslationError(e)
                )
            } finally {
                if (iidRef.current === iid0) setTranslating(false)
            }
        })()
    }, [translationConfig, targetLang, translated, item.iid, item.content])

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
                />
                {transError && (
                    <div className={styles.transError} role="alert">
                        {transError}
                    </div>
                )}
                <div className={styles.viewport}>
                    <ArticleView
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
