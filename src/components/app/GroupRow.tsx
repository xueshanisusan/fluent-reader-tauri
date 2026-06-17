import * as React from "react"
import styles from "./Sidebar.module.css"

export interface GroupRowProps {
    name: string
    expanded: boolean
    unread: number
    onToggleExpand: () => void
    children: React.ReactNode
}

export function GroupRow(props: GroupRowProps): React.ReactElement {
    const { name, expanded, unread, onToggleExpand, children } = props
    const caretClass = expanded
        ? `${styles.groupCaret} ${styles.groupCaretOpen}`
        : styles.groupCaret
    return (
        <>
            <div className={styles.groupHeader} onClick={onToggleExpand}>
                <span className={caretClass}>▶</span>
                <span className={styles.label}>{name}</span>
                {unread > 0 && (
                    <span
                        className={`${styles.badge} ${
                            expanded ? styles.badgeMuted : ""
                        }`}>
                        {unread}
                    </span>
                )}
            </div>
            {expanded && <div className={styles.groupChildren}>{children}</div>}
        </>
    )
}
