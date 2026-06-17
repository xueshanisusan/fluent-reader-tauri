import * as React from "react"
import type { Filter } from "./useArticleList"
import styles from "./FilterBar.module.css"

export interface FilterBarProps {
    filter: Filter
    onChange: (f: Filter) => void
}

const OPTIONS: Array<{ value: Filter; label: string }> = [
    { value: "all", label: "All" },
    { value: "unread", label: "Unread" },
    { value: "starred", label: "Starred" },
]

export function FilterBar(props: FilterBarProps): React.ReactElement {
    const { filter, onChange } = props
    return (
        <div className={styles.bar}>
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
