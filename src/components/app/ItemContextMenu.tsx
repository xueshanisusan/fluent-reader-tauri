import * as React from "react"
import type { Item } from "../../scripts/db-bridge"
import styles from "./ItemContextMenu.module.css"

export interface ItemContextMenuProps {
    x: number
    y: number
    item: Item
    onToggleRead: () => void
    onToggleStar: () => void
    onOpenInBrowser: () => void
    onCopyLink: () => void
    onCopyTitle: () => void
    onDismiss: () => void
}

// Right-click menu for a feed item. Mirrors SourceContextMenu's mechanics
// (fixed position from clientX/clientY, dismiss on outside mousedown + Escape).
// Faithful subset of the original Fluent Reader item menu; Hide / full-text
// fetch are deferred (no item-level backend command yet).
export function ItemContextMenu(
    props: ItemContextMenuProps
): React.ReactElement {
    const {
        x,
        y,
        item,
        onToggleRead,
        onToggleStar,
        onOpenInBrowser,
        onCopyLink,
        onCopyTitle,
        onDismiss,
    } = props
    const ref = React.useRef<HTMLDivElement | null>(null)
    const hasLink = !!item.link

    React.useLayoutEffect(() => {
        if (ref.current) {
            ref.current.style.left = `${x}px`
            ref.current.style.top = `${y}px`
        }
    }, [x, y])

    React.useEffect(() => {
        function onDocDown(e: MouseEvent): void {
            if (!ref.current) return
            if (!ref.current.contains(e.target as Node)) onDismiss()
        }
        function onKey(e: KeyboardEvent): void {
            if (e.key === "Escape") onDismiss()
        }
        document.addEventListener("mousedown", onDocDown)
        document.addEventListener("keydown", onKey)
        return () => {
            document.removeEventListener("mousedown", onDocDown)
            document.removeEventListener("keydown", onKey)
        }
    }, [onDismiss])

    return (
        <div ref={ref} className={styles.menu}>
            <div className={styles.item} onClick={onToggleRead}>
                {item.hasRead ? "Mark as unread" : "Mark as read"}
            </div>
            <div className={styles.item} onClick={onToggleStar}>
                {item.starred ? "Unstar" : "Star"}
            </div>
            <div className={styles.divider} />
            <div
                className={`${styles.item} ${hasLink ? "" : styles.itemDisabled}`}
                onClick={hasLink ? onOpenInBrowser : undefined}>
                Open in browser
            </div>
            <div
                className={`${styles.item} ${hasLink ? "" : styles.itemDisabled}`}
                onClick={hasLink ? onCopyLink : undefined}>
                Copy link
            </div>
            <div className={styles.item} onClick={onCopyTitle}>
                Copy title
            </div>
        </div>
    )
}
