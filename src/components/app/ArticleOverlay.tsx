import * as React from "react"
import type { Item } from "../../scripts/db-bridge"
import type { HostStyle, ArticleMeta } from "../article/iframe-bootstrap"
import { ArticleView } from "../article/ArticleView"
import { ArticleToolbar } from "./ArticleToolbar"
import { formatArticleDate } from "../../scripts/format"
import styles from "./ArticleOverlay.module.css"

export interface ArticleOverlayProps {
    item: Item
    hostStyle: HostStyle
    articleId: string
    // Source display name for the in-article header meta line.
    sourceName?: string
    // When false (a modal/search overlay is open above this), the overlay must
    // NOT handle Esc — otherwise one keystroke closes both the modal and the
    // article. The modal owns Esc in that case.
    escEnabled: boolean
    onClose: () => void
    onToggleRead: () => void
    onToggleStar: () => void
    onLink: (url: string) => void
    onKey: (key: string) => void
    onCtxMenu: (d: {
        x: number
        y: number
        text: string | null
        href: string | null
    }) => void
}

export function ArticleOverlay(props: ArticleOverlayProps): React.ReactElement {
    const {
        item,
        hostStyle,
        articleId,
        sourceName,
        escEnabled,
        onClose,
        onToggleRead,
        onToggleStar,
        onLink,
        onKey,
        onCtxMenu,
    } = props

    const meta: ArticleMeta = {
        title: item.title,
        link: item.link,
        dateText: formatArticleDate(item.dateMs),
        sourceName: sourceName ?? "",
        creator: item.creator,
    }

    React.useEffect(() => {
        if (!escEnabled) return
        function onKeyDown(e: KeyboardEvent): void {
            if (e.key === "Escape") {
                e.preventDefault()
                onClose()
            }
        }
        window.addEventListener("keydown", onKeyDown)
        return () => window.removeEventListener("keydown", onKeyDown)
    }, [escEnabled, onClose])

    return (
        <div className={styles.overlay}>
            <ArticleToolbar
                item={item}
                onToggleRead={onToggleRead}
                onToggleStar={onToggleStar}
                onClose={onClose}
            />
            <div className={styles.viewport}>
                <ArticleView
                    key={articleId}
                    html={item.content}
                    articleId={articleId}
                    hostStyle={hostStyle}
                    meta={meta}
                    onLink={onLink}
                    onKey={onKey}
                    onCtxMenu={onCtxMenu}
                />
            </div>
        </div>
    )
}
