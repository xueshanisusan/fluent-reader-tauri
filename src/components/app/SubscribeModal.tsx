import * as React from "react"
import type { DiscoveredFeed } from "../../scripts/feeds-bridge"
import styles from "./SubscribeModal.module.css"

export interface SubscribeModalProps {
    open: boolean
    url: string
    inFlight: boolean
    status: string | null
    picker: DiscoveredFeed[] | null
    onChangeUrl: (v: string) => void
    onSubmit: () => void
    onPick: (feed: DiscoveredFeed) => void
    onCancelPick: () => void
    onClose: () => void
}

export function SubscribeModal(
    props: SubscribeModalProps
): React.ReactElement | null {
    const {
        open,
        url,
        inFlight,
        status,
        picker,
        onChangeUrl,
        onSubmit,
        onPick,
        onCancelPick,
        onClose,
    } = props

    const inputRef = React.useRef<HTMLInputElement | null>(null)

    React.useEffect(() => {
        if (!open) return
        function onKey(e: KeyboardEvent): void {
            if (e.key === "Escape") onClose()
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    }, [open, onClose])

    React.useEffect(() => {
        if (open && !picker) inputRef.current?.focus()
    }, [open, picker])

    if (!open) return null

    return (
        <div className={styles.overlay} onClick={onClose}>
            <div
                className={styles.panel}
                onClick={e => e.stopPropagation()}
                role="dialog"
                aria-label="Add feed">
                <div className={styles.header}>
                    <span className={styles.title}>Add feed</span>
                    <button
                        className={`${styles.btn} ${styles.btnSecondary}`}
                        onClick={onClose}>
                        Close
                    </button>
                </div>
                <div className={styles.body}>
                    {picker ? (
                        <>
                            <div className={styles.hint}>
                                {picker.length} feed
                                {picker.length === 1 ? "" : "s"} found — pick one
                                to subscribe.
                            </div>
                            {picker.map((f, i) => (
                                <div
                                    key={`${f.url}-${i}`}
                                    className={styles.pickerRow}>
                                    <button
                                        className={styles.pickerBtn}
                                        disabled={inFlight}
                                        onClick={() => onPick(f)}>
                                        Add
                                    </button>
                                    <span className={styles.pickerLabel}>
                                        {f.title ? `${f.title} — ` : ""}
                                        <span className={styles.pickerUrl}>
                                            {f.url}
                                        </span>
                                    </span>
                                </div>
                            ))}
                        </>
                    ) : (
                        <div className={styles.inputRow}>
                            <input
                                ref={inputRef}
                                className={styles.input}
                                type="text"
                                placeholder="https://example.com or https://example.com/feed.xml"
                                value={url}
                                onChange={e => onChangeUrl(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === "Enter") onSubmit()
                                }}
                                disabled={inFlight}
                            />
                            <button
                                className={styles.btn}
                                disabled={inFlight || !url.trim()}
                                onClick={onSubmit}>
                                {inFlight ? "…" : "Add"}
                            </button>
                        </div>
                    )}
                    {status && <div className={styles.status}>{status}</div>}
                </div>
                {picker && (
                    <div className={styles.footer}>
                        <button
                            className={`${styles.btn} ${styles.btnSecondary}`}
                            onClick={onCancelPick}>
                            Back
                        </button>
                    </div>
                )}
            </div>
        </div>
    )
}
