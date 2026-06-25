// Thin wrapper around @tauri-apps/api/window for the custom title bar.
// Decorations are disabled at the Tauri level (tauri.conf.json), so the
// app draws its own min/max/close + drag region. The drag-region itself
// is handled via the `data-tauri-drag-region` HTML attribute; this module
// only covers the button callbacks and maximize-state tracking.

import { getCurrentWindow } from "@tauri-apps/api/window"

export function minimizeWindow(): Promise<void> {
    return getCurrentWindow().minimize()
}

export function toggleMaximizeWindow(): Promise<void> {
    return getCurrentWindow().toggleMaximize()
}

export function closeWindow(): Promise<void> {
    return getCurrentWindow().close()
}

export function isWindowMaximized(): Promise<boolean> {
    return getCurrentWindow().isMaximized()
}

// Subscribes to window resize events to keep the maximize/restore icon in
// sync. Returns an unlisten function for the caller's cleanup.
export async function onMaximizeChange(
    cb: (maximized: boolean) => void
): Promise<() => void> {
    const win = getCurrentWindow()
    const unlisten = await win.onResized(() => {
        void win.isMaximized().then(cb)
    })
    return unlisten
}
