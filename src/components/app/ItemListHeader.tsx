import * as React from "react"
import type { Filter } from "./useArticleList"
import styles from "./ItemListHeader.module.css"

export interface ItemListHeaderProps {
    filter: Filter
    onChange: (f: Filter) => void
}

const OPTIONS: Array<{ value: Filter; label: string }> = [
    { value: "all", label: "All" },
    { value: "unread", label: "Unread" },
    { value: "starred", label: "Starred" },
    { value: "hidden", label: "Hidden" },
]

export function ItemListHeader(props: ItemListHeaderProps): React.ReactElement {
    const { filter, onChange } = props
    return (
        <div className={styles.header}>
            {OPTIONS.map(opt => (
                <button
                    key={opt.value}
                    className={
                        filter === opt.value
                            ? `${styles.chip} ${styles.active}`
                            : styles.chip
                    }
                    onClick={() => onChange(opt.value)}>
                    {opt.label}
                </button>
            ))}
        </div>
    )
}
