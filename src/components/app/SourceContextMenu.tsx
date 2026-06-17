import * as React from "react"
import styles from "./SourceContextMenu.module.css"

export interface SourceContextMenuProps {
    x: number
    y: number
    onRename: () => void
    onDelete: () => void
    onDismiss: () => void
}

export function SourceContextMenu(
    props: SourceContextMenuProps
): React.ReactElement {
    const { x, y, onRename, onDelete, onDismiss } = props
    const ref = React.useRef<HTMLDivElement | null>(null)

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
            <div className={styles.item} onClick={onRename}>
                Rename
            </div>
            <div
                className={`${styles.item} ${styles.itemDanger}`}
                onClick={onDelete}>
                Delete
            </div>
        </div>
    )
}
