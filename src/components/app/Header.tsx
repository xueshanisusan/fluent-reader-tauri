import * as React from "react"
import type { Item } from "../../scripts/db-bridge"
import styles from "./Header.module.css"

export interface HeaderProps {
    itemsCount: number | null
    selectedItem: Item | null
    refreshInFlight: boolean
    refreshStatus: string | null
    hasUnread: boolean
    opmlBusy: boolean
    onToggleRead: () => void
    onToggleStar: () => void
    onMarkAllRead: () => void
    onRefresh: () => void
    onRemountIframe: () => void
    onImportOpml: () => void
    onExportOpml: () => void
    onOpenSettings: () => void
}

export function Header(props: HeaderProps): React.ReactElement {
    const {
        itemsCount,
        selectedItem,
        refreshInFlight,
        refreshStatus,
        hasUnread,
        opmlBusy,
        onToggleRead,
        onToggleStar,
        onMarkAllRead,
        onRefresh,
        onRemountIframe,
        onImportOpml,
        onExportOpml,
        onOpenSettings,
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
            <button
                className={styles.btn}
                disabled={opmlBusy}
                onClick={onImportOpml}>
                Import OPML
            </button>
            <button
                className={styles.btn}
                disabled={opmlBusy}
                onClick={onExportOpml}>
                Export OPML
            </button>
            <button className={styles.btn} onClick={onOpenSettings}>
                Settings
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
