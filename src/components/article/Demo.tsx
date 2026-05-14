import * as React from "react"
import { ArticleView } from "./ArticleView"
import { openExternal } from "../../scripts/shell-bridge"
// eslint-disable-next-line import/no-unresolved
import fixtureHtml from "./fixture.html"

const overlayStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    zIndex: 99998,
    display: "flex",
    flexDirection: "column",
}

const buttonStyle: React.CSSProperties = {
    position: "fixed",
    right: 16,
    bottom: 16,
    zIndex: 99999,
    padding: "10px 14px",
    borderRadius: 4,
    border: "1px solid #444",
    background: "#222",
    color: "#fff",
    fontSize: 13,
    cursor: "pointer",
}

const overlayHeaderStyle: React.CSSProperties = {
    display: "flex",
    gap: 8,
    padding: 8,
    background: "#222",
    color: "#fff",
    fontSize: 13,
}

const headerBtnStyle: React.CSSProperties = {
    padding: "4px 10px",
    background: "#444",
    border: "1px solid #666",
    color: "#fff",
    cursor: "pointer",
}

export function Demo(): React.ReactElement {
    const [show, setShow] = React.useState(false)
    const [articleId, setArticleId] = React.useState(0)

    const handleLink = React.useCallback((url: string) => {
        openExternal(url).catch(err => {
            console.error("[Demo] openExternal failed", err)
            window.alert("无法打开链接: " + err)
        })
    }, [])

    const handleKey = React.useCallback((key: string) => {
        if (key === "Escape") setShow(false)
    }, [])

    const handleCtxMenu = React.useCallback((d: { x: number; y: number; text: string | null; href: string | null }) => {
        console.log("[Demo] ctxmenu", d)
    }, [])

    if (!show) {
        return (
            <button style={buttonStyle} onClick={() => setShow(true)}>
                Open A3 demo article
            </button>
        )
    }

    return (
        <div style={overlayStyle}>
            <div style={overlayHeaderStyle}>
                <span style={{ flex: 1 }}>A3 demo (articleId = {articleId})</span>
                <button style={headerBtnStyle} onClick={() => setArticleId(n => n + 1)}>
                    Remount (kill switch)
                </button>
                <button style={headerBtnStyle} onClick={() => setShow(false)}>
                    Close (Esc)
                </button>
            </div>
            <div style={{ flex: 1, background: "#fff" }}>
                <ArticleView
                    html={fixtureHtml}
                    articleId={articleId}
                    onLink={handleLink}
                    onKey={handleKey}
                    onCtxMenu={handleCtxMenu}
                />
            </div>
        </div>
    )
}
