import * as React from "react"
import styles from "./Highlights.module.css"

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export interface HighlightsProps {
    text: string
    query: string
}

// Wraps case-insensitive substring matches of the WHOLE `query` in <mark>,
// mirroring the backend search (repo::items::search runs a single whole-query
// LIKE on title/snippet — it does NOT split on spaces, so neither do we; keep
// these consistent). Empty query or an invalid pattern falls back to plain
// text. Split-with-capture-group yields [text, match, text, match, …]; odd
// indices are the matches.
export function Highlights({
    text,
    query,
}: HighlightsProps): React.ReactElement {
    const q = query.trim()
    if (!q) return <>{text}</>
    let parts: string[]
    try {
        parts = text.split(new RegExp(`(${escapeRegExp(q)})`, "gi"))
    } catch {
        return <>{text}</>
    }
    return (
        <>
            {parts.map((part, i) =>
                i % 2 === 1 ? (
                    <mark key={i} className={styles.mark}>
                        {part}
                    </mark>
                ) : (
                    part
                )
            )}
        </>
    )
}
