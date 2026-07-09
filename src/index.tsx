import * as React from "react"
import { createRoot } from "react-dom/client"
import { App } from "./components/App"
import { applyStoredTheme } from "./scripts/theme"
import { initGlobalShortcuts } from "./scripts/shortcut-bridge"
import "./styles/tokens.css"

const container = document.getElementById("app")
if (!container) {
    throw new Error("missing #app root in index.html")
}
void applyStoredTheme()
void initGlobalShortcuts()
createRoot(container).render(<App />)
