import * as React from "react"
import {
    closeWindow,
    isWindowMaximized,
    minimizeWindow,
    onMaximizeChange,
    toggleMaximizeWindow,
} from "../../scripts/window-bridge"
import styles from "./TitleBar.module.css"

export interface TitleBarProps {
    title: string
}

export function TitleBar(props: TitleBarProps): React.ReactElement {
    const { title } = props
    const [maximized, setMaximized] = React.useState(false)

    React.useEffect(() => {
        let unlisten: (() => void) | null = null
        let cancelled = false
        void (async () => {
            try {
                setMaximized(await isWindowMaximized())
                const u = await onMaximizeChange(setMaximized)
                if (cancelled) u()
                else unlisten = u
            } catch (e) {
                console.error("[TitleBar] maximize tracking failed", e)
            }
        })()
        return () => {
            cancelled = true
            if (unlisten) unlisten()
        }
    }, [])

    return (
        <div className={styles.bar}>
            <div className={styles.title} data-tauri-drag-region>
                {title}
            </div>
            <div className={styles.controls}>
                <button
                    className={styles.btn}
                    onClick={() => void minimizeWindow()}
                    aria-label="Minimize"
                    title="Minimize">
                    <MinimizeIcon />
                </button>
                <button
                    className={styles.btn}
                    onClick={() => void toggleMaximizeWindow()}
                    aria-label={maximized ? "Restore" : "Maximize"}
                    title={maximized ? "Restore" : "Maximize"}>
                    {maximized ? <RestoreIcon /> : <MaximizeIcon />}
                </button>
                <button
                    className={styles.closeBtn}
                    onClick={() => void closeWindow()}
                    aria-label="Close"
                    title="Close">
                    <CloseIcon />
                </button>
            </div>
        </div>
    )
}

function MinimizeIcon(): React.ReactElement {
    return (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
        </svg>
    )
}

function MaximizeIcon(): React.ReactElement {
    return (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect
                x="0.5"
                y="0.5"
                width="9"
                height="9"
                fill="none"
                stroke="currentColor"
            />
        </svg>
    )
}

function RestoreIcon(): React.ReactElement {
    return (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect
                x="2.5"
                y="0.5"
                width="7"
                height="7"
                fill="none"
                stroke="currentColor"
            />
            <rect
                x="0.5"
                y="2.5"
                width="7"
                height="7"
                fill="var(--bg-header, #222)"
                stroke="currentColor"
            />
        </svg>
    )
}

function CloseIcon(): React.ReactElement {
    return (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <line
                x1="0.5"
                y1="0.5"
                x2="9.5"
                y2="9.5"
                stroke="currentColor"
            />
            <line
                x1="9.5"
                y1="0.5"
                x2="0.5"
                y2="9.5"
                stroke="currentColor"
            />
        </svg>
    )
}
