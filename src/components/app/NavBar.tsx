import * as React from "react"
import type { LogEntry } from "../../scripts/log-store"
import {
    closeWindow,
    isWindowMaximized,
    minimizeWindow,
    onMaximizeChange,
    toggleMaximizeWindow,
} from "../../scripts/window-bridge"
import { LogsPanel } from "./LogsPanel"
import styles from "./NavBar.module.css"

export interface NavBarProps {
    refreshInFlight: boolean
    refreshStatus: string | null
    hasUnread: boolean
    logEntries: ReadonlyArray<LogEntry>
    onToggleSidebar: () => void
    onToggleSearch: () => void
    onMarkAllRead: () => void
    onRefresh: () => void
    onOpenSettings: () => void
    onJumpToSource: (sid: number) => void
    onClearLogs: () => void
}

export function NavBar(props: NavBarProps): React.ReactElement {
    const {
        refreshInFlight,
        refreshStatus,
        hasUnread,
        logEntries,
        onToggleSidebar,
        onToggleSearch,
        onMarkAllRead,
        onRefresh,
        onOpenSettings,
        onJumpToSource,
        onClearLogs,
    } = props

    const [maximized, setMaximized] = React.useState(false)
    const [logsOpen, setLogsOpen] = React.useState(false)

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
            <button
                className={styles.iconBtn}
                onClick={onToggleSidebar}
                aria-label="Toggle sidebar"
                title="Toggle sidebar">
                <MenuIcon />
            </button>
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
                    data-logs-bell
                    onClick={() => setLogsOpen(v => !v)}
                    aria-label="Show logs"
                    aria-expanded={logsOpen}
                    title="Show logs">
                    <BellIcon />
                </button>
                <button
                    className={styles.iconBtn}
                    onClick={onToggleSearch}
                    aria-label="Search articles"
                    title="Search articles">
                    <SearchIcon />
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
            {logsOpen && (
                <LogsPanel
                    entries={logEntries}
                    onJumpToSource={onJumpToSource}
                    onClear={onClearLogs}
                    onClose={() => setLogsOpen(false)}
                />
            )}
        </div>
    )
}

// ---- Icons (inline SVGs, currentColor) ----

function MenuIcon(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <rect x="2" y="3" width="12" height="1.4" />
            <rect x="2" y="7.3" width="12" height="1.4" />
            <rect x="2" y="11.6" width="12" height="1.4" />
        </svg>
    )
}

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

function SearchIcon(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <line x1="10.5" y1="10.5" x2="14" y2="14" strokeLinecap="round" />
        </svg>
    )
}

function BellIcon(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
            <path d="M3.5 11.5V7.5a4.5 4.5 0 0 1 9 0v4" />
            <path d="M2.5 11.5h11" />
            <path d="M6.5 13.5a1.5 1.5 0 0 0 3 0" />
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
