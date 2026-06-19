import * as React from "react"
import { createRoot } from "react-dom/client"
import { App } from "./components/App"
import { applyStoredTheme } from "./scripts/theme"
import "./styles/tokens.css"

const container = document.getElementById("app")
if (!container) {
    throw new Error("missing #app root in index.html")
}
void applyStoredTheme()
createRoot(container).render(<App />)
