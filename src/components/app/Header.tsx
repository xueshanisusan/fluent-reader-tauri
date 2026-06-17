import * as React from "react"
import type { Item } from "../../scripts/db-bridge"
import styles from "./Header.module.css"

export interface HeaderProps {
    itemsCount: number | null
    selectedItem: Item | null
    refreshInFlight: boolean
    refreshStatus: string | null
    hasUnread: boolean
    onToggleRead: () => void
    onToggleStar: () => void
    onMarkAllRead: () => void
    onRefresh: () => void
    onOpenSources: () => void
    onRemountIframe: () => void
}

export function Header(props: HeaderProps): React.ReactElement {
    const {
        itemsCount,
        selectedItem,
        refreshInFlight,
        refreshStatus,
        hasUnread,
        onToggleRead,
        onToggleStar,
        onMarkAllRead,
        onRefresh,
        onOpenSources,
        onRemountIframe,
    } = props

    return (
        <div className={styles.bar}>
            <span className={styles.title}>
                fluent-reader{itemsCount !== null ? ` — ${itemsCount} items` : ""}
                {selectedItem ? ` — ${selectedItem.title}` : ""}
                {refreshStatus && (
                    <span className={styles.status}>{refreshStatus}</span>
                )}
            </span>
            <button
                className={styles.btn}
                disabled={!selectedItem}
                onClick={onToggleRead}>
                {selectedItem?.hasRead ? "Mark unread" : "Mark read"}
            </button>
            <button
                className={styles.btn}
                disabled={!selectedItem}
                onClick={onToggleStar}>
                {selectedItem?.starred ? "Unstar" : "Star"}
            </button>
            <button
                className={styles.btn}
                disabled={!hasUnread}
                onClick={onMarkAllRead}>
                Mark all read
            </button>
            <button
                className={styles.btn}
                disabled={refreshInFlight}
                onClick={onRefresh}>
                {refreshInFlight ? "Refreshing…" : "Refresh feeds"}
            </button>
            <button className={styles.btn} onClick={onOpenSources}>
                Sources
            </button>
            <button
                className={styles.btn}
                disabled={!selectedItem}
                onClick={onRemountIframe}>
                Remount iframe
            </button>
        </div>
    )
}
