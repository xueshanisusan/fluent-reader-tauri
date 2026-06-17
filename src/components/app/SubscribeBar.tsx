import * as React from "react"
import type { DiscoveredFeed } from "../../scripts/feeds-bridge"
import styles from "./SubscribeBar.module.css"

export interface SubscribeBarProps {
    url: string
    inFlight: boolean
    status: string | null
    picker: DiscoveredFeed[] | null
    onChangeUrl: (v: string) => void
    onSubmit: () => void
    onPick: (feed: DiscoveredFeed) => void
    onCancelPick: () => void
}

export function SubscribeBar(props: SubscribeBarProps): React.ReactElement {
    const {
        url,
        inFlight,
        status,
        picker,
        onChangeUrl,
        onSubmit,
        onPick,
        onCancelPick,
    } = props

    return (
        <div className={styles.bar}>
            {picker ? (
                <div className={styles.picker}>
                    {picker.map((f, i) => (
                        <div key={`${f.url}-${i}`} className={styles.pickerRow}>
                            <button
                                className={styles.pickerBtn}
                                disabled={inFlight}
                                onClick={() => onPick(f)}>
                                Add
                            </button>
                            <span className={styles.pickerLabel}>
                                {f.title ? `${f.title} — ` : ""}
                                <span className={styles.pickerUrl}>{f.url}</span>
                            </span>
                        </div>
                    ))}
                    <div className={styles.pickerRow}>
                        <button
                            className={styles.pickerBtn}
                            onClick={onCancelPick}>
                            Cancel
                        </button>
                    </div>
                </div>
            ) : (
                <>
                    <span>Add feed:</span>
                    <input
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
                </>
            )}
            {status && !picker && <span className={styles.status}>{status}</span>}
        </div>
    )
}
