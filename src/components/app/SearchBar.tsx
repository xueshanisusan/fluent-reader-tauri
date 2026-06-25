import * as React from "react"
import styles from "./SearchBar.module.css"

export interface SearchBarProps {
    value: string
    onChange: (q: string) => void
    onClose: () => void
}

export function SearchBar(props: SearchBarProps): React.ReactElement {
    const { value, onChange, onClose } = props
    const inputRef = React.useRef<HTMLInputElement | null>(null)

    React.useEffect(() => {
        inputRef.current?.focus()
    }, [])

    return (
        <div className={styles.bar}>
            <input
                ref={inputRef}
                className={styles.input}
                type="search"
                placeholder="Search articles…"
                aria-label="Search articles"
                value={value}
                onChange={e => onChange(e.target.value)}
                onKeyDown={e => {
                    if (e.key === "Escape") onClose()
                }}
            />
            <button
                className={styles.closeBtn}
                onClick={onClose}
                aria-label="Close search"
                title="Close (Esc)">
                <CloseIcon />
            </button>
        </div>
    )
}

function CloseIcon(): React.ReactElement {
    return (
        <svg width="12" height="12" viewBox="0 0 10 10" aria-hidden="true">
            <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" stroke="currentColor" />
            <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" stroke="currentColor" />
        </svg>
    )
}
