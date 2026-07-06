import * as React from "react"
import type { Item } from "../../scripts/db-bridge"
import type { TranslationTarget } from "../../scripts/settings-bridge"
import styles from "./ArticleToolbar.module.css"

export interface ArticleToolbarProps {
    item: Item
    sourceName?: string
    iconUrl?: string | null
    onToggleRead: () => void
    onToggleStar: () => void
    onToggleHidden: () => void
    onOpenInBrowser: () => void
    onClose?: () => void
    // Translation (shown only when a translation provider is enabled). translated
    // = currently showing the translated text; translating = a request is in
    // flight (button disabled + spinner).
    translateEnabled?: boolean
    translating?: boolean
    translated?: boolean
    onToggleTranslate?: () => void
    // Per-article target-language routing. The picker shows only when there are
    // ≥2 configured targets; picking one re-translates into that language.
    translateTargets?: TranslationTarget[]
    currentLang?: string
    onPickTarget?: (lang: string) => void
}

// Header for the article overlay, matching the original Fluent Reader: source
// (favicon + name) on the left, action buttons on the right. The article title
// itself lives in the body header (see iframe-bootstrap buildHeader), not here.
export function ArticleToolbar(
    props: ArticleToolbarProps
): React.ReactElement {
    const {
        item,
        sourceName,
        iconUrl,
        onToggleRead,
        onToggleStar,
        onToggleHidden,
        onOpenInBrowser,
        onClose,
        translateEnabled,
        translating,
        translated,
        onToggleTranslate,
        translateTargets,
        currentLang,
        onPickTarget,
    } = props
    const [iconOk, setIconOk] = React.useState(true)
    const showTargetPicker =
        translateEnabled && (translateTargets?.length ?? 0) >= 2

    return (
        <div className={styles.bar}>
            {onClose && (
                <button
                    className={styles.iconBtn}
                    onClick={onClose}
                    aria-label="Close"
                    title="Close (Esc)">
                    <CloseIcon />
                </button>
            )}
            <div className={styles.source}>
                {iconUrl && iconOk && (
                    <img
                        className={styles.icon}
                        src={iconUrl}
                        alt=""
                        onError={() => setIconOk(false)}
                    />
                )}
                <span className={styles.sourceName}>{sourceName}</span>
            </div>
            <button
                className={styles.iconBtn}
                onClick={onToggleRead}
                aria-label={item.hasRead ? "Mark unread" : "Mark read"}
                title={item.hasRead ? "Mark unread" : "Mark read"}>
                {item.hasRead ? <MailIcon /> : <MailOpenIcon />}
            </button>
            <button
                className={`${styles.iconBtn} ${item.starred ? styles.starredOn : ""}`}
                onClick={onToggleStar}
                aria-label={item.starred ? "Unstar" : "Star"}
                title={item.starred ? "Unstar" : "Star"}>
                {item.starred ? <StarFilledIcon /> : <StarOutlineIcon />}
            </button>
            <button
                className={styles.iconBtn}
                onClick={onToggleHidden}
                aria-label={item.hidden ? "Unhide" : "Hide"}
                title={item.hidden ? "Unhide" : "Hide"}>
                {item.hidden ? <EyeIcon /> : <EyeOffIcon />}
            </button>
            {showTargetPicker && (
                <select
                    className={styles.langSelect}
                    value={currentLang}
                    disabled={translating}
                    onChange={e => onPickTarget?.(e.target.value)}
                    aria-label="Translate into"
                    title={`Translate into ${currentLang}`}>
                    {translateTargets!.map(t => (
                        <option key={t.lang} value={t.lang}>
                            {t.lang}
                        </option>
                    ))}
                </select>
            )}
            {translateEnabled && (
                <button
                    className={`${styles.iconBtn} ${translated ? styles.starredOn : ""}`}
                    onClick={onToggleTranslate}
                    disabled={translating}
                    aria-label={translated ? "Show original" : "Translate"}
                    title={
                        translating
                            ? "Translating…"
                            : translated
                              ? "Show original"
                              : "Translate"
                    }>
                    {translating ? <SpinnerIcon /> : <TranslateIcon />}
                </button>
            )}
            <button
                className={styles.iconBtn}
                onClick={onOpenInBrowser}
                aria-label="Open in browser"
                title="Open in browser">
                <GlobeIcon />
            </button>
        </div>
    )
}

function TranslateIcon(): React.ReactElement {
    return (
        <svg width="15" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <text
                x="0.5"
                y="8"
                fontSize="8"
                fontFamily="sans-serif"
                fill="currentColor">
                A
            </text>
            <text x="7" y="15" fontSize="8" fill="currentColor">
                文
            </text>
        </svg>
    )
}

function SpinnerIcon(): React.ReactElement {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            className={styles.spin}
            aria-hidden="true">
            <path d="M8 2a6 6 0 1 1-6 6" strokeLinecap="round" />
        </svg>
    )
}

function CloseIcon(): React.ReactElement {
    return (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
        </svg>
    )
}

function MailIcon(): React.ReactElement {
    // closed envelope = already read
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <rect x="2" y="4" width="12" height="9" rx="1" />
            <path d="M2 5l6 4 6-4" />
        </svg>
    )
}

function MailOpenIcon(): React.ReactElement {
    // open envelope = unread
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <path d="M2 7l6-4 6 4v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7z" />
            <path d="M2 7l6 4 6-4" />
        </svg>
    )
}

function StarOutlineIcon(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <path d="M8 1.5l2 4.4 4.8.6-3.5 3.3.9 4.8L8 12.3l-4.2 2.3.9-4.8L1.2 6.5 6 5.9z" />
        </svg>
    )
}

function StarFilledIcon(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 1.5l2 4.4 4.8.6-3.5 3.3.9 4.8L8 12.3l-4.2 2.3.9-4.8L1.2 6.5 6 5.9z" />
        </svg>
    )
}

function EyeOffIcon(): React.ReactElement {
    // hide action
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6.5 4.2A6 6 0 0 1 8 4c3.5 0 6 4 6 4a10 10 0 0 1-1.8 2.1M3.8 5.9A10 10 0 0 0 2 8s2.5 4 6 4a6 6 0 0 0 2.1-.4" />
            <path d="M2 2l12 12" />
        </svg>
    )
}

function EyeIcon(): React.ReactElement {
    // unhide action
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
            <circle cx="8" cy="8" r="2" />
        </svg>
    )
}

function GlobeIcon(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
            <circle cx="8" cy="8" r="6" />
            <path d="M2 8h12M8 2c1.8 1.6 2.8 3.8 2.8 6S9.8 12.4 8 14C6.2 12.4 5.2 10.2 5.2 8S6.2 3.6 8 2z" />
        </svg>
    )
}
