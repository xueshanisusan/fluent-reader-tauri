import * as React from "react"
import type { Item } from "../../scripts/db-bridge"
import styles from "./ItemList.module.css"

export interface ItemListProps {
    items: Item[]
    selectedIid: number | null
    onSelect: (it: Item) => void
}

export function ItemList(props: ItemListProps): React.ReactElement {
    const { items, selectedIid, onSelect } = props
    return (
        <div className={styles.list}>
            {items.map(it => {
                const selected = selectedIid === it.iid
                const rowClass = [
                    styles.row,
                    it.hasRead ? styles.read : "",
                    selected ? styles.selected : "",
                ]
                    .filter(Boolean)
                    .join(" ")
                const titleClass = it.hasRead
                    ? `${styles.title} ${styles.read}`
                    : styles.title
                return (
                    <div
                        key={it.iid}
                        className={rowClass}
                        onClick={() => onSelect(it)}>
                        <div className={titleClass}>
                            {it.title}
                            {it.starred && <span className={styles.star}>★</span>}
                        </div>
                        <div className={styles.date}>
                            {new Date(it.dateMs).toLocaleString()}
                        </div>
                    </div>
                )
            })}
        </div>
    )
}
