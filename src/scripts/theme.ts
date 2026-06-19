// Resolves a stored ThemeSettings value to a concrete light/dark mode and
// applies it to document.documentElement as data-theme. For "system", listens
// to the OS color-scheme media query and reapplies on change.

import { settings, ThemeSettings } from "./settings-bridge"

type Resolved = "light" | "dark"

const DARK_QUERY = "(prefers-color-scheme: dark)"

let mediaListener: ((e: MediaQueryListEvent) => void) | null = null
let mediaQuery: MediaQueryList | null = null

function resolve(t: ThemeSettings): Resolved {
    if (t === ThemeSettings.Dark) return "dark"
    if (t === ThemeSettings.Light) return "light"
    return getMediaQuery().matches ? "dark" : "light"
}

function getMediaQuery(): MediaQueryList {
    if (!mediaQuery) mediaQuery = window.matchMedia(DARK_QUERY)
    return mediaQuery
}

function apply(resolved: Resolved): void {
    document.documentElement.setAttribute("data-theme", resolved)
}

function detachMediaListener(): void {
    if (mediaListener && mediaQuery) {
        mediaQuery.removeEventListener("change", mediaListener)
    }
    mediaListener = null
}

function attachMediaListener(): void {
    detachMediaListener()
    const mq = getMediaQuery()
    mediaListener = e => apply(e.matches ? "dark" : "light")
    mq.addEventListener("change", mediaListener)
}

export async function applyStoredTheme(): Promise<void> {
    try {
        const t = await settings.get("theme")
        apply(resolve(t))
        if (t === ThemeSettings.Default) attachMediaListener()
        else detachMediaListener()
    } catch (e) {
        // Falling back to light keeps the app usable if the store can't load.
        console.error("[theme] applyStoredTheme failed", e)
        apply("light")
    }
}

export async function setTheme(t: ThemeSettings): Promise<void> {
    await settings.set("theme", t)
    apply(resolve(t))
    if (t === ThemeSettings.Default) attachMediaListener()
    else detachMediaListener()
}
