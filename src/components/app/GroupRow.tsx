import * as React from "react"
import styles from "./Sidebar.module.css"

export interface GroupRowProps {
    name: string
    expanded: boolean
    // Whether this group is the current feed (its name is highlighted).
    selected: boolean
    unread: number
    // Select the whole-group feed (clicking the name/row, not the caret).
    onSelect: () => void
    onToggleExpand: () => void
    children: React.ReactNode
}

export function GroupRow(props: GroupRowProps): React.ReactElement {
    const { name, expanded, selected, unread, onSelect, onToggleExpand, children } =
        props
    const caretClass = expanded
        ? `${styles.groupCaret} ${styles.groupCaretOpen}`
        : styles.groupCaret
    // Clicking the row selects the group; the caret is its own hit target that
    // only toggles expansion (mirrors the original — select and expand are
    // independent, so selecting never collapses/expands the children).
    const headerClass = selected
        ? `${styles.groupHeader} ${styles.active}`
        : styles.groupHeader
    return (
        <>
            <div className={headerClass} onClick={onSelect}>
                <span
                    className={caretClass}
                    onClick={e => {
                        e.stopPropagation()
                        onToggleExpand()
                    }}>
                    ▶
                </span>
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
