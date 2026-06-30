import * as React from "react"
import type { Source } from "../../scripts/db-bridge"
import styles from "./Sidebar.module.css"

export interface SourceRowProps {
    source: Source
    active: boolean
    unread: number
    renaming: boolean
    onSelect: () => void
    onContextMenu: (e: React.MouseEvent) => void
    onCommitRename: (name: string) => void
    onCancelRename: () => void
}

export function SourceRow(props: SourceRowProps): React.ReactElement {
    const {
        source,
        active,
        unread,
        renaming,
        onSelect,
        onContextMenu,
        onCommitRename,
        onCancelRename,
    } = props
    const [draft, setDraft] = React.useState(source.name)

    React.useEffect(() => {
        if (renaming) setDraft(source.name)
    }, [renaming, source.name])

    if (renaming) {
        const commit = () => {
            const v = draft.trim()
            if (v && v !== source.name) onCommitRename(v)
            else onCancelRename()
        }
        return (
            <div className={styles.row}>
                <input
                    className={styles.editInput}
                    type="text"
                    autoFocus
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={e => {
                        if (e.key === "Enter") commit()
                        else if (e.key === "Escape") onCancelRename()
                    }}
                />
            </div>
        )
    }

    const rowClass = active ? `${styles.row} ${styles.active}` : styles.row
    const remote = source.serviceRef != null
    return (
        <div
            className={rowClass}
            onClick={onSelect}
            onContextMenu={e => {
                e.preventDefault()
                onContextMenu(e)
            }}>
            <span className={styles.label} title={source.name}>
                {source.name}
            </span>
            {remote && (
                <span
                    className={styles.syncBadge}
                    title="Synced from service"
                    aria-label="Synced from service">
                    <CloudIcon />
                </span>
            )}
            {unread > 0 && <span className={styles.badge}>{unread}</span>}
        </div>
    )
}

function CloudIcon(): React.ReactElement {
    return (
        <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true">
            <path d="M4.5 12.5a3 3 0 0 1-.4-5.97 3.5 3.5 0 0 1 6.74-1.06A2.75 2.75 0 0 1 11.5 12.5z" />
        </svg>
    )
}
