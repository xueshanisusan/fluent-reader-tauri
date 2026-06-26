import * as React from "react"
import type { Item } from "../../scripts/db-bridge"
import styles from "./ArticleToolbar.module.css"

export interface ArticleToolbarProps {
    item: Item
    onToggleRead: () => void
    onToggleStar: () => void
    onClose?: () => void
}

export function ArticleToolbar(
    props: ArticleToolbarProps
): React.ReactElement {
    const { item, onToggleRead, onToggleStar, onClose } = props
    return (
        <div className={styles.bar}>
            {onClose && (
                <button
                    className={styles.iconBtn}
                    onClick={onClose}
                    aria-label="Back to list"
                    title="Back">
                    <BackIcon />
                </button>
            )}
            <span className={styles.title}>{item.title}</span>
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
        </div>
    )
}

function BackIcon(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 3L5 8l5 5" />
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
