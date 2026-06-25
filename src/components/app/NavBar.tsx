import * as React from "react"
import {
    closeWindow,
    isWindowMaximized,
    minimizeWindow,
    onMaximizeChange,
    toggleMaximizeWindow,
} from "../../scripts/window-bridge"
import styles from "./NavBar.module.css"

export interface NavBarProps {
    refreshInFlight: boolean
    refreshStatus: string | null
    hasUnread: boolean
    opmlBusy: boolean
    searchQuery: string
    onSearchChange: (q: string) => void
    onMarkAllRead: () => void
    onRefresh: () => void
    onImportOpml: () => void
    onExportOpml: () => void
    onOpenSettings: () => void
}

export function NavBar(props: NavBarProps): React.ReactElement {
    const {
        refreshInFlight,
        refreshStatus,
        hasUnread,
        opmlBusy,
        searchQuery,
        onSearchChange,
        onMarkAllRead,
        onRefresh,
        onImportOpml,
        onExportOpml,
        onOpenSettings,
    } = props

    const [maximized, setMaximized] = React.useState(false)

    React.useEffect(() => {
        let unlisten: (() => void) | null = null
        let cancelled = false
        void (async () => {
            try {
                setMaximized(await isWindowMaximized())
                const u = await onMaximizeChange(setMaximized)
                if (cancelled) u()
                else unlisten = u
            } catch (e) {
                console.error("[NavBar] maximize tracking failed", e)
            }
        })()
        return () => {
            cancelled = true
            if (unlisten) unlisten()
        }
    }, [])

    return (
        <div className={styles.bar}>
            <div className={styles.title} data-tauri-drag-region>
                <span className={styles.titleText} data-tauri-drag-region>
                    Fluent Reader
                </span>
                {refreshStatus && (
                    <span className={styles.status} data-tauri-drag-region>
                        {refreshStatus}
                    </span>
                )}
            </div>
            <input
                className={styles.searchInput}
                type="search"
                placeholder="Search articles…"
                aria-label="Search articles"
                value={searchQuery}
                onChange={e => onSearchChange(e.target.value)}
            />
            <div className={styles.actions}>
                <button
                    className={styles.iconBtn}
                    disabled={refreshInFlight}
                    onClick={onRefresh}
                    aria-label="Refresh feeds"
                    title="Refresh feeds">
                    <RefreshIcon />
                </button>
                <button
                    className={styles.iconBtn}
                    disabled={!hasUnread}
                    onClick={onMarkAllRead}
                    aria-label="Mark all read"
                    title="Mark all read">
                    <InboxCheckIcon />
                </button>
                <button
                    className={styles.iconBtn}
                    disabled={opmlBusy}
                    onClick={onImportOpml}
                    aria-label="Import OPML"
                    title="Import OPML">
                    <ImportIcon />
                </button>
                <button
                    className={styles.iconBtn}
                    disabled={opmlBusy}
                    onClick={onExportOpml}
                    aria-label="Export OPML"
                    title="Export OPML">
                    <ExportIcon />
                </button>
                <button
                    className={styles.iconBtn}
                    onClick={onOpenSettings}
                    aria-label="Settings"
                    title="Settings">
                    <SettingsIcon />
                </button>
            </div>
            <div className={styles.separator} />
            <div className={styles.windowControls}>
                <button
                    className={styles.windowBtn}
                    onClick={() => void minimizeWindow()}
                    aria-label="Minimize"
                    title="Minimize">
                    <MinimizeIcon />
                </button>
                <button
                    className={styles.windowBtn}
                    onClick={() => void toggleMaximizeWindow()}
                    aria-label={maximized ? "Restore" : "Maximize"}
                    title={maximized ? "Restore" : "Maximize"}>
                    {maximized ? <RestoreIcon /> : <MaximizeIcon />}
                </button>
                <button
                    className={styles.closeBtn}
                    onClick={() => void closeWindow()}
                    aria-label="Close"
                    title="Close">
                    <CloseIcon />
                </button>
            </div>
        </div>
    )
}

// ---- Icons (12px inline SVGs, currentColor) ----

function RefreshIcon(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M13.65 2.35a8 8 0 1 0 1.34 9.18l-1.4-.7A6.5 6.5 0 1 1 12.49 3.5H10v1.5h5V0h-1.5v2.35z" />
        </svg>
    )
}

function InboxCheckIcon(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <path d="M2 9v4a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9" />
            <path d="M2 9l2-6h8l2 6" />
            <path d="M5 9h2a1 1 0 0 1 2 0h2" />
            <path d="M10 5l1.5 1.5L14 4" stroke="currentColor" />
        </svg>
    )
}

function ImportIcon(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <path d="M8 1v9" />
            <path d="M5 7l3 3 3-3" />
            <path d="M2 13h12" />
        </svg>
    )
}

function ExportIcon(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <path d="M8 11V2" />
            <path d="M5 5l3-3 3 3" />
            <path d="M2 13h12" />
        </svg>
    )
}

function SettingsIcon(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
            <circle cx="8" cy="8" r="2.2" />
            <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4" />
        </svg>
    )
}

function MinimizeIcon(): React.ReactElement {
    return (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
        </svg>
    )
}

function MaximizeIcon(): React.ReactElement {
    return (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
        </svg>
    )
}

function RestoreIcon(): React.ReactElement {
    return (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="2.5" y="0.5" width="7" height="7" fill="none" stroke="currentColor" />
            <rect x="0.5" y="2.5" width="7" height="7" fill="var(--bg-header, #222)" stroke="currentColor" />
        </svg>
    )
}

function CloseIcon(): React.ReactElement {
    return (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" stroke="currentColor" />
            <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" stroke="currentColor" />
        </svg>
    )
}
