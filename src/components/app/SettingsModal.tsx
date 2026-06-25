import * as React from "react"
import {
    settings,
    ThemeSettings,
    type SettingsShape,
} from "../../scripts/settings-bridge"
import { setTheme } from "../../scripts/theme"
import { openExternal } from "../../scripts/shell-bridge"
import pkg from "../../../package.json"
import styles from "./SettingsModal.module.css"

export interface SettingsModalProps {
    open: boolean
    opmlBusy: boolean
    onClose: () => void
    onChanged: (next: SettingsShape) => void
    onImportOpml: () => void
    onExportOpml: () => void
}

type Draft = Pick<
    SettingsShape,
    "theme" | "fontSize" | "fontFamily" | "fetchInterval" | "notificationsEnabled"
>

type Tab = "application" | "subscriptions" | "about"

const THEME_LABELS: Array<{ value: ThemeSettings; label: string }> = [
    { value: ThemeSettings.Default, label: "System" },
    { value: ThemeSettings.Light, label: "Light" },
    { value: ThemeSettings.Dark, label: "Dark" },
]

const PIVOT_ITEMS: Array<{ value: Tab; label: string }> = [
    { value: "application", label: "Application" },
    { value: "subscriptions", label: "Subscriptions" },
    { value: "about", label: "About" },
]

const APP_VERSION = pkg.version
const REPO_URL = "https://github.com/yang991178/fluent-reader"

export function SettingsModal(props: SettingsModalProps): React.ReactElement | null {
    const { open, opmlBusy, onClose, onChanged, onImportOpml, onExportOpml } = props
    const [draft, setDraft] = React.useState<Draft | null>(null)
    const [saving, setSaving] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)
    const [tab, setTab] = React.useState<Tab>("application")

    React.useEffect(() => {
        if (!open) {
            setDraft(null)
            setError(null)
            return
        }
        setTab("application")
        let cancelled = false
        void (async () => {
            try {
                const all = await settings.getAll()
                if (cancelled) return
                setDraft({
                    theme: all.theme,
                    fontSize: all.fontSize,
                    fontFamily: all.fontFamily,
                    fetchInterval: all.fetchInterval,
                    notificationsEnabled: all.notificationsEnabled,
                })
            } catch (e) {
                if (cancelled) return
                setError("Load failed: " + String((e as Error)?.message ?? e))
            }
        })()
        return () => {
            cancelled = true
        }
    }, [open])

    React.useEffect(() => {
        if (!open) return
        function onKey(e: KeyboardEvent): void {
            if (e.key === "Escape") onClose()
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    }, [open, onClose])

    const onSave = React.useCallback(async () => {
        if (!draft) return
        setSaving(true)
        setError(null)
        try {
            const all = await settings.getAll()
            const next: SettingsShape = {
                ...all,
                theme: draft.theme,
                fontSize: draft.fontSize,
                fontFamily: draft.fontFamily,
                fetchInterval: draft.fetchInterval,
                notificationsEnabled: draft.notificationsEnabled,
            }
            if (all.theme !== draft.theme) await setTheme(draft.theme)
            if (all.fontSize !== draft.fontSize)
                await settings.set("fontSize", draft.fontSize)
            if (all.fontFamily !== draft.fontFamily)
                await settings.set("fontFamily", draft.fontFamily)
            if (all.fetchInterval !== draft.fetchInterval)
                await settings.set("fetchInterval", draft.fetchInterval)
            if (all.notificationsEnabled !== draft.notificationsEnabled)
                await settings.set(
                    "notificationsEnabled",
                    draft.notificationsEnabled
                )
            onChanged(next)
            onClose()
        } catch (e) {
            setError("Save failed: " + String((e as Error)?.message ?? e))
        } finally {
            setSaving(false)
        }
    }, [draft, onChanged, onClose])

    const openRepo = React.useCallback(() => {
        openExternal(REPO_URL).catch(e =>
            console.error("[SettingsModal] open repo failed", e)
        )
    }, [])

    if (!open) return null

    return (
        <div className={styles.overlay} onClick={onClose}>
            <div className={styles.drawer} onClick={e => e.stopPropagation()} role="dialog" aria-label="Settings">
                <div className={styles.header}>
                    <span className={styles.title}>Settings</span>
                    <button
                        className={`${styles.btn} ${styles.btnSecondary}`}
                        onClick={onClose}>
                        Close
                    </button>
                </div>
                <div className={styles.pivot} role="tablist">
                    {PIVOT_ITEMS.map(p => (
                        <button
                            key={p.value}
                            role="tab"
                            aria-selected={tab === p.value}
                            className={`${styles.pivotItem} ${tab === p.value ? styles.pivotItemActive : ""}`}
                            onClick={() => setTab(p.value)}>
                            {p.label}
                        </button>
                    ))}
                </div>
                <div className={styles.body}>
                    {draft === null && tab === "application" ? (
                        <div>Loading…</div>
                    ) : tab === "application" && draft !== null ? (
                        <div className={styles.section}>
                            <div className={styles.field}>
                                <label className={styles.label}>Theme</label>
                                <div className={styles.radioGroup}>
                                    {THEME_LABELS.map(opt => (
                                        <label
                                            key={opt.value}
                                            className={styles.radio}>
                                            <input
                                                type="radio"
                                                name="theme"
                                                checked={draft.theme === opt.value}
                                                onChange={() =>
                                                    setDraft({
                                                        ...draft,
                                                        theme: opt.value,
                                                    })
                                                }
                                            />
                                            {opt.label}
                                        </label>
                                    ))}
                                </div>
                            </div>

                            <div className={styles.field}>
                                <label className={styles.label}>
                                    Article font size
                                </label>
                                <input
                                    type="number"
                                    min={12}
                                    max={28}
                                    className={styles.numberInput}
                                    value={draft.fontSize}
                                    onChange={e =>
                                        setDraft({
                                            ...draft,
                                            fontSize: clamp(
                                                Number(e.target.value) || 16,
                                                12,
                                                28
                                            ),
                                        })
                                    }
                                />
                                <span className={styles.hint}>
                                    12–28 px. Applies to the article reading
                                    pane only.
                                </span>
                            </div>

                            <div className={styles.field}>
                                <label className={styles.label}>
                                    Article font family
                                </label>
                                <input
                                    type="text"
                                    className={styles.input}
                                    placeholder="system default"
                                    value={draft.fontFamily}
                                    onChange={e =>
                                        setDraft({
                                            ...draft,
                                            fontFamily: e.target.value,
                                        })
                                    }
                                />
                                <span className={styles.hint}>
                                    e.g. <code>Georgia, serif</code> or leave
                                    blank for system default.
                                </span>
                            </div>

                            <div className={styles.field}>
                                <label className={styles.radio}>
                                    <input
                                        type="checkbox"
                                        checked={draft.notificationsEnabled}
                                        onChange={e =>
                                            setDraft({
                                                ...draft,
                                                notificationsEnabled:
                                                    e.target.checked,
                                            })
                                        }
                                    />
                                    Show notifications for matching items
                                </label>
                                <span className={styles.hint}>
                                    Rules with a Notify action fire OS
                                    notifications when the app is not focused.
                                </span>
                            </div>

                            <div className={styles.field}>
                                <label className={styles.label}>
                                    Default refresh interval for new sources
                                </label>
                                <input
                                    type="number"
                                    min={0}
                                    max={1440}
                                    className={styles.numberInput}
                                    value={draft.fetchInterval}
                                    onChange={e =>
                                        setDraft({
                                            ...draft,
                                            fetchInterval: clamp(
                                                Number(e.target.value) || 0,
                                                0,
                                                1440
                                            ),
                                        })
                                    }
                                />
                                <span className={styles.hint}>
                                    Minutes between automatic refreshes when
                                    subscribing to a new feed. 0 = manual only.
                                </span>
                            </div>

                            {error && (
                                <div className={styles.errorMessage}>
                                    {error}
                                </div>
                            )}
                        </div>
                    ) : tab === "subscriptions" ? (
                        <div className={styles.section}>
                            <div className={styles.field}>
                                <label className={styles.label}>
                                    OPML
                                </label>
                                <div className={styles.opmlRow}>
                                    <button
                                        className={`${styles.btn} ${styles.btnSecondary}`}
                                        disabled={opmlBusy}
                                        onClick={onImportOpml}>
                                        Import OPML…
                                    </button>
                                    <button
                                        className={`${styles.btn} ${styles.btnSecondary}`}
                                        disabled={opmlBusy}
                                        onClick={onExportOpml}>
                                        Export OPML…
                                    </button>
                                </div>
                                <span className={styles.hint}>
                                    Import merges new feeds into your current
                                    list. Export saves all subscriptions to a
                                    file.
                                </span>
                            </div>
                        </div>
                    ) : tab === "about" ? (
                        <div className={styles.section}>
                            <div className={styles.aboutTitle}>
                                Fluent Reader
                            </div>
                            <div className={styles.aboutVersion}>
                                Version {APP_VERSION} · Tauri build
                            </div>
                            <div className={styles.aboutTagline}>
                                A modern desktop RSS reader.
                            </div>
                            <button
                                className={styles.aboutLink}
                                onClick={openRepo}>
                                View project on GitHub
                            </button>
                        </div>
                    ) : null}
                </div>
                <div className={styles.footer}>
                    <button
                        className={`${styles.btn} ${styles.btnSecondary}`}
                        onClick={onClose}
                        disabled={saving}>
                        Cancel
                    </button>
                    <button
                        className={styles.btn}
                        onClick={onSave}
                        disabled={!draft || saving || tab !== "application"}>
                        {saving ? "Saving…" : "Save"}
                    </button>
                </div>
            </div>
        </div>
    )
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, Math.round(n)))
}
