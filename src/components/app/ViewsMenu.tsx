import * as React from "react"
import { ViewType, ViewConfigs } from "../../scripts/settings-bridge"
import styles from "./ViewsMenu.module.css"

export interface ViewsMenuProps {
    current: ViewType
    listViewConfigs: ViewConfigs
    onSelect: (v: ViewType) => void
    onToggleConfig: (bit: ViewConfigs) => void
    onClose: () => void
}

interface ViewOption {
    value: ViewType
    label: string
}

const OPTIONS: ViewOption[] = [
    { value: ViewType.Cards, label: "Cards" },
    { value: ViewType.List, label: "List" },
    { value: ViewType.Magazine, label: "Magazine" },
    { value: ViewType.Compact, label: "Compact" },
]

// Display toggles for the List view only (matching the original Fluent Reader,
// which applies ViewConfigs to List). Shown when the current view is List.
const TOGGLES: Array<{ bit: ViewConfigs; label: string }> = [
    { bit: ViewConfigs.ShowCover, label: "Show cover" },
    { bit: ViewConfigs.ShowSnippet, label: "Show snippet" },
    { bit: ViewConfigs.FadeRead, label: "Fade read" },
]

export function ViewsMenu(props: ViewsMenuProps): React.ReactElement {
    const { current, listViewConfigs, onSelect, onToggleConfig, onClose } = props
    const ref = React.useRef<HTMLDivElement | null>(null)

    React.useEffect(() => {
        function onDocDown(e: MouseEvent): void {
            if (!ref.current) return
            const t = e.target as Element | null
            if (!t) return
            if (ref.current.contains(t)) return
            if (t.closest && t.closest("[data-views-btn]")) return
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

    return (
        <div ref={ref} className={styles.menu} role="menu" aria-label="View">
            {OPTIONS.map(opt => {
                const active = opt.value === current
                return (
                    <button
                        key={opt.value}
                        role="menuitemradio"
                        aria-checked={active}
                        className={styles.item}
                        onClick={() => {
                            onSelect(opt.value)
                            onClose()
                        }}>
                        <span
                            className={`${styles.check} ${active ? "" : styles.checkHidden}`}
                            aria-hidden="true">
                            <CheckIcon />
                        </span>
                        <span className={styles.label}>{opt.label}</span>
                    </button>
                )
            })}
            {current === ViewType.List && (
                <>
                    <div className={styles.divider} role="separator" />
                    {TOGGLES.map(t => {
                        const on = !!(listViewConfigs & t.bit)
                        return (
                            <button
                                key={t.bit}
                                role="menuitemcheckbox"
                                aria-checked={on}
                                className={styles.item}
                                onClick={() => onToggleConfig(t.bit)}>
                                <span
                                    className={`${styles.check} ${on ? "" : styles.checkHidden}`}
                                    aria-hidden="true">
                                    <CheckIcon />
                                </span>
                                <span className={styles.label}>{t.label}</span>
                            </button>
                        )
                    })}
                </>
            )}
        </div>
    )
}

function CheckIcon(): React.ReactElement {
    return (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 8.5l3 3 7-7" />
        </svg>
    )
}
