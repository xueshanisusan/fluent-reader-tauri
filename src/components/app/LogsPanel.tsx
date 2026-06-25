import * as React from "react"
import type { LogEntry } from "../../scripts/log-store"
import styles from "./LogsPanel.module.css"

export interface LogsPanelProps {
    entries: ReadonlyArray<LogEntry>
    onJumpToSource: (sid: number) => void
    onClear: () => void
    onClose: () => void
}

export function LogsPanel(props: LogsPanelProps): React.ReactElement {
    const { entries, onJumpToSource, onClear, onClose } = props
    const ref = React.useRef<HTMLDivElement | null>(null)

    React.useEffect(() => {
        function onDocDown(e: MouseEvent): void {
            if (!ref.current) return
            const t = e.target as Element | null
            if (!t) return
            if (ref.current.contains(t)) return
            if (t.closest && t.closest("[data-logs-bell]")) return
            onClose()
        }
        function onKey(e: KeyboardEvent): void {
            if (e.key === "Escape") onClose()
        }
        document.addEventListener("mousedown", onDocDown)
        document.addEventListener("keydown", onKey)
        return () => {
            document.removeEventListener("mousedown", onDocDown)
            document.removeEventListener("keydown", onKey)
        }
    }, [onClose])

    // Sort newest-first by ts, with id as a stable tiebreaker for entries
    // produced in the same millisecond (refreshAll parallel ingest).
    const sorted = React.useMemo(() => {
        return entries
            .slice()
            .sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1))
    }, [entries])

    return (
        <div ref={ref} className={styles.panel} role="dialog" aria-label="Logs">
            <div className={styles.header}>
                <span className={styles.title}>Logs</span>
                <button
                    className={styles.clearBtn}
                    onClick={onClear}
                    disabled={entries.length === 0}>
                    Clear all
                </button>
            </div>
            <div className={styles.list}>
                {sorted.length === 0 ? (
                    <div className={styles.empty}>No activity yet.</div>
                ) : (
                    sorted.map(entry => (
                        <Row
                            key={entry.id}
                            entry={entry}
                            onJump={sid => {
                                onJumpToSource(sid)
                                onClose()
                            }}
                        />
                    ))
                )}
            </div>
        </div>
    )
}

function Row(props: {
    entry: LogEntry
    onJump: (sid: number) => void
}): React.ReactElement {
    const { entry, onJump } = props
    const time = formatTime(entry.ts)

    switch (entry.kind) {
        case "refresh-success": {
            const summary =
                entry.outcome.kind === "updated"
                    ? `${entry.outcome.inserted} new`
                    : "not modified"
            return (
                <div
                    className={`${styles.row} ${styles.rowClickable}`}
                    onClick={() => onJump(entry.sourceId)}
                    title={`${entry.sourceName} · ${summary}`}>
                    <SuccessIcon className={styles.rowIcon} />
                    <div className={styles.rowBody}>
                        <div className={styles.rowPrimary}>{entry.sourceName}</div>
                        <div className={styles.rowSecondary}>{summary}</div>
                    </div>
                    <div className={styles.rowMeta}>
                        <span>{time}</span>
                        {entry.trigger === "auto" && (
                            <span className={styles.badge}>auto</span>
                        )}
                    </div>
                </div>
            )
        }
        case "refresh-error": {
            const detail = `${entry.error.kind}: ${entry.error.message}`
            return (
                <div
                    className={`${styles.row} ${styles.rowClickable}`}
                    onClick={() => onJump(entry.sourceId)}
                    title={`${entry.sourceName} · ${detail}`}>
                    <ErrorIcon className={`${styles.rowIcon} ${styles.rowError}`} />
                    <div className={styles.rowBody}>
                        <div className={styles.rowPrimary}>{entry.sourceName}</div>
                        <div
                            className={`${styles.rowSecondary} ${styles.rowSecondaryError}`}>
                            {detail}
                        </div>
                    </div>
                    <div className={styles.rowMeta}>
                        <span>{time}</span>
                        {entry.trigger === "auto" && (
                            <span className={styles.badge}>auto</span>
                        )}
                    </div>
                </div>
            )
        }
        case "opml-import": {
            const s = entry.summary
            const summary = `${s.sourcesAdded} added · ${s.sourcesSkipped} skipped · ${s.groupsCreated} group${s.groupsCreated === 1 ? "" : "s"}`
            return (
                <div className={styles.row} title={`OPML import · ${summary}`}>
                    <OpmlIcon className={styles.rowIcon} />
                    <div className={styles.rowBody}>
                        <div className={styles.rowPrimary}>OPML import</div>
                        <div className={styles.rowSecondary}>{summary}</div>
                    </div>
                    <div className={styles.rowMeta}>
                        <span>{time}</span>
                    </div>
                </div>
            )
        }
        case "opml-import-error": {
            const detail = `${entry.error.kind}: ${entry.error.message}`
            return (
                <div className={styles.row} title={`OPML import failed · ${detail}`}>
                    <ErrorIcon className={`${styles.rowIcon} ${styles.rowError}`} />
                    <div className={styles.rowBody}>
                        <div className={styles.rowPrimary}>OPML import failed</div>
                        <div
                            className={`${styles.rowSecondary} ${styles.rowSecondaryError}`}>
                            {detail}
                        </div>
                    </div>
                    <div className={styles.rowMeta}>
                        <span>{time}</span>
                    </div>
                </div>
            )
        }
        case "opml-export-success": {
            const summary = `${entry.bytes.toLocaleString()} bytes`
            return (
                <div className={styles.row} title={`OPML export · ${summary}`}>
                    <OpmlIcon className={styles.rowIcon} />
                    <div className={styles.rowBody}>
                        <div className={styles.rowPrimary}>OPML export</div>
                        <div className={styles.rowSecondary}>{summary}</div>
                    </div>
                    <div className={styles.rowMeta}>
                        <span>{time}</span>
                    </div>
                </div>
            )
        }
        case "opml-export-error": {
            const detail = `${entry.error.kind}: ${entry.error.message}`
            return (
                <div className={styles.row} title={`OPML export failed · ${detail}`}>
                    <ErrorIcon className={`${styles.rowIcon} ${styles.rowError}`} />
                    <div className={styles.rowBody}>
                        <div className={styles.rowPrimary}>OPML export failed</div>
                        <div
                            className={`${styles.rowSecondary} ${styles.rowSecondaryError}`}>
                            {detail}
                        </div>
                    </div>
                    <div className={styles.rowMeta}>
                        <span>{time}</span>
                    </div>
                </div>
            )
        }
    }
}

function formatTime(ts: number): string {
    const d = new Date(ts)
    const h = String(d.getHours()).padStart(2, "0")
    const m = String(d.getMinutes()).padStart(2, "0")
    return `${h}:${m}`
}

// ---- Icons ----

interface IconProps {
    className?: string
}

function SuccessIcon({ className }: IconProps): React.ReactElement {
    return (
        <svg
            className={className}
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true">
            <path d="M3 8.5l3 3 7-7" />
        </svg>
    )
}

function ErrorIcon({ className }: IconProps): React.ReactElement {
    return (
        <svg
            className={className}
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            aria-hidden="true">
            <circle cx="8" cy="8" r="6.5" />
            <line x1="8" y1="4.5" x2="8" y2="9" />
            <line x1="8" y1="11" x2="8" y2="11.5" />
        </svg>
    )
}

function OpmlIcon({ className }: IconProps): React.ReactElement {
    return (
        <svg
            className={className}
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
            aria-hidden="true">
            <path d="M2.5 3.5h4l1.5 1.5h5.5v7.5h-11z" />
        </svg>
    )
}
