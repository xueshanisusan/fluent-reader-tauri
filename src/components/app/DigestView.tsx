import * as React from "react"
import type { HostStyle } from "../article/iframe-bootstrap"
import {
    ViewType,
    ViewConfigs,
    type TranslationConfig,
} from "../../scripts/settings-bridge"
import { ItemList, type SourceMeta } from "./ItemList"
import { ArticleOverlay } from "./ArticleOverlay"
import { openDigestLink, type UseDigest } from "./useDigest"
import layout from "./layout.module.css"
import styles from "./DigestView.module.css"

export interface DigestViewProps {
    digest: UseDigest
    viewMode: ViewType
    sourceMeta: ReadonlyMap<number, SourceMeta>
    hostStyle: HostStyle
    remount: number
    escEnabled: boolean
    onCtxMenu: (d: {
        x: number
        y: number
        text: string | null
        href: string | null
    }) => void
    translationConfig?: TranslationConfig
}

function statusText(d: UseDigest): string {
    if (d.loading && d.items === null) return "Building today's digest…"
    if (d.error) return `Digest failed: ${d.error}`
    if (d.total === 0) return "No unread articles today — enjoy the break 🎉"
    if (d.remaining === 0) return "All done for today 🎉"
    return `${d.remaining} of ${d.total} left`
}

export function DigestView(props: DigestViewProps): React.ReactElement {
    const {
        digest,
        viewMode,
        sourceMeta,
        hostStyle,
        remount,
        escEnabled,
        onCtxMenu,
        translationConfig,
    } = props
    const { items, selectedItem } = digest

    return (
        <div className={layout.gridArea}>
            <div className={styles.header}>
                <span className={styles.title}>Daily Digest</span>
                <span className={styles.status}>{statusText(digest)}</span>
                <button
                    className={styles.regen}
                    onClick={() => void digest.regenerate()}
                    disabled={digest.loading}>
                    Regenerate
                </button>
            </div>
            {items === null ? (
                <div className={layout.centered}>Loading…</div>
            ) : items.length === 0 ? (
                <div className={layout.itemColumnEmpty}>
                    <div>Nothing in today's digest.</div>
                    <div className={layout.emptyHint}>
                        Read your feeds or hit Regenerate.
                    </div>
                </div>
            ) : (
                <ItemList
                    items={items}
                    selectedIid={selectedItem?.iid ?? null}
                    viewMode={viewMode}
                    sources={sourceMeta}
                    // Fade already-read items so the remaining picks stand out.
                    listViewConfigs={ViewConfigs.ShowCover | ViewConfigs.FadeRead}
                    onSelect={digest.onOpenItem}
                />
            )}
            {selectedItem && (
                <ArticleOverlay
                    item={selectedItem}
                    hostStyle={hostStyle}
                    articleId={`${selectedItem.iid}@${remount}`}
                    sourceName={sourceMeta.get(selectedItem.sourceId)?.name}
                    iconUrl={sourceMeta.get(selectedItem.sourceId)?.iconUrl}
                    escEnabled={escEnabled}
                    onClose={() => digest.setSelectedItem(null)}
                    onToggleRead={digest.onToggleRead}
                    onToggleStar={digest.onToggleStar}
                    onToggleHidden={() =>
                        void digest.onSetHiddenItem(
                            selectedItem,
                            !selectedItem.hidden
                        )
                    }
                    onOpenInBrowser={() => openDigestLink(selectedItem.link)}
                    onLink={openDigestLink}
                    onKey={() => {}}
                    onCtxMenu={onCtxMenu}
                    translationConfig={translationConfig}
                />
            )}
        </div>
    )
}
