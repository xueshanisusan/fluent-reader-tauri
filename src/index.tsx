import * as React from "react"
import { createRoot } from "react-dom/client"
import { App } from "./components/App"

const container = document.getElementById("app")
if (!container) {
    throw new Error("missing #app root in index.html")
}
createRoot(container).render(<App />)
