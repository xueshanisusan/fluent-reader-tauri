import * as React from "react"
import type { Source } from "../../scripts/db-bridge"
import styles from "./SourcesModal.module.css"

export interface SourcesModalProps {
    sources: Source[]
    deleteInFlight: number | null
    onClose: () => void
    onDelete: (s: Source) => void
}

export function SourcesModal(props: SourcesModalProps): React.ReactElement {
    const { sources, deleteInFlight, onClose, onDelete } = props
    return (
        <div className={styles.overlay} onClick={onClose}>
            <div className={styles.panel} onClick={e => e.stopPropagation()}>
                <div className={styles.header}>
                    <span className={styles.title}>
                        Sources ({sources.length})
                    </span>
                    <button className={styles.closeBtn} onClick={onClose}>
                        Close
                    </button>
                </div>
                <div className={styles.list}>
                    {sources.length === 0 ? (
                        <div className={styles.empty}>
                            No sources yet. Subscribe to one from the bar.
                        </div>
                    ) : (
                        sources.map(s => (
                            <div key={s.sid} className={styles.row}>
                                <div className={styles.rowMain}>
                                    <div className={styles.name}>{s.name}</div>
                                    <div className={styles.url}>{s.url}</div>
                                </div>
                                <button
                                    className={styles.deleteBtn}
                                    disabled={deleteInFlight === s.sid}
                                    onClick={() => onDelete(s)}>
                                    {deleteInFlight === s.sid ? "…" : "Delete"}
                                </button>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    )
}
