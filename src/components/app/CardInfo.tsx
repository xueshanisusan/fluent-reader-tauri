import * as React from "react"
import { formatRelative } from "../../scripts/format"
import styles from "./CardInfo.module.css"

export interface CardInfoProps {
    name?: string
    iconUrl?: string | null
    creator: string | null
    starred: boolean
    hasRead: boolean
    dateMs: number
    showCreator?: boolean
    hideTime?: boolean
    // Optional extra class on the root <p>, so a consumer (e.g. the magazine
    // card) can override the default .info margin without editing this shared
    // module. Cards pass nothing, so their rendering is unchanged.
    className?: string
}

// Mirrors the original Fluent Reader's CardInfo (src/components/cards/info.tsx):
// favicon + source name (+ optional creator) + starred star + UNREAD dot + time.
export function CardInfo(props: CardInfoProps): React.ReactElement {
    const {
        name,
        iconUrl,
        creator,
        starred,
        hasRead,
        dateMs,
        showCreator,
        hideTime,
        className,
    } = props
    const [iconOk, setIconOk] = React.useState(true)

    return (
        <p className={[styles.info, className].filter(Boolean).join(" ")}>
            {iconUrl && iconOk && (
                <img
                    className={styles.icon}
                    src={iconUrl}
                    alt=""
                    onError={() => setIconOk(false)}
                />
            )}
            <span className={styles.name}>
                {name}
                {showCreator && creator && (
                    <span className={styles.creator}>{creator}</span>
                )}
            </span>
            {starred && <span className={styles.starred} aria-label="Starred" />}
            {!hasRead && <span className={styles.unread} aria-label="Unread" />}
            {!hideTime && (
                <span className={styles.time}>{formatRelative(dateMs)}</span>
            )}
        </p>
    )
}
