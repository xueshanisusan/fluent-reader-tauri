import { getCurrentWindow } from "@tauri-apps/api/window"
import { register, unregister } from "@tauri-apps/plugin-global-shortcut"
import { invoke } from "@tauri-apps/api/core"

export async function initGlobalShortcuts(): Promise<() => void> {
    const SHOW = "Super+KeyD"
    const QUIT = "Control+KeyQ"

    await register(SHOW, async (event) => {
        if (event.state !== "Pressed") return
        const win = getCurrentWindow()
        try {
            if (await win.isVisible()) {
                await win.hide()
            } else {
                await win.show()
                await win.setFocus()
            }
        } catch {
            // window may be gone
        }
    })

    await register(QUIT, async (event) => {
        if (event.state !== "Pressed") return
        await invoke("exit_app")
    })

    return async () => {
        await unregister(SHOW)
        await unregister(QUIT)
    }
}
