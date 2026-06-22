import * as React from "react"
import {
    rules as rulesApi,
    type NewRule,
    type RulePatch,
    type SourceRule,
} from "../../scripts/db-bridge"
import {
    MASK_CREATOR,
    MASK_SNIPPET,
    MASK_TITLE,
} from "./rules-mask"
import styles from "./RulesModal.module.css"

export interface RulesModalProps {
    sourceId: number | null
    sourceName: string
    onClose: () => void
    onChanged?: () => void
}

interface Draft {
    rid: number // 0 = new
    filterTypeMask: number
    filterSearch: string
    filterMatch: boolean
    actionRead: number | null
    actionStar: number | null
    actionHide: number | null
    actionNotify: number | null
}

function ruleToDraft(r: SourceRule): Draft {
    return {
        rid: r.rid,
        filterTypeMask: r.filterTypeMask,
        filterSearch: r.filterSearch,
        filterMatch: r.filterMatch,
        actionRead: r.actionRead,
        actionStar: r.actionStar,
        actionHide: r.actionHide,
        actionNotify: r.actionNotify,
    }
}

function emptyDraft(): Draft {
    return {
        rid: 0,
        filterTypeMask: MASK_TITLE,
        filterSearch: "",
        filterMatch: true,
        actionRead: null,
        actionStar: null,
        actionHide: null,
        actionNotify: null,
    }
}

function draftsEqualIgnoringPosition(a: Draft, b: Draft): boolean {
    return (
        a.rid === b.rid &&
        a.filterTypeMask === b.filterTypeMask &&
        a.filterSearch === b.filterSearch &&
        a.filterMatch === b.filterMatch &&
        a.actionRead === b.actionRead &&
        a.actionStar === b.actionStar &&
        a.actionHide === b.actionHide &&
        a.actionNotify === b.actionNotify
    )
}

function isMeaningful(d: Draft): boolean {
    // Drop rows with no fields checked AND empty search — they can never match.
    return d.filterTypeMask !== 0 || d.filterSearch.trim() !== ""
}

export function RulesModal(props: RulesModalProps): React.ReactElement | null {
    const { sourceId, sourceName, onClose, onChanged } = props
    const [snapshot, setSnapshot] = React.useState<SourceRule[] | null>(null)
    const [draft, setDraft] = React.useState<Draft[]>([])
    const [saving, setSaving] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)

    React.useEffect(() => {
        if (sourceId === null) {
            setSnapshot(null)
            setDraft([])
            setError(null)
            return
        }
        let cancelled = false
        void (async () => {
            try {
                const list = await rulesApi.list(sourceId)
                if (cancelled) return
                const sorted = [...list].sort((a, b) => a.position - b.position)
                setSnapshot(sorted)
                setDraft(sorted.map(ruleToDraft))
                setError(null)
            } catch (e) {
                if (cancelled) return
                setError("Load failed: " + String((e as Error)?.message ?? e))
            }
        })()
        return () => {
            cancelled = true
        }
    }, [sourceId])

    const updateAt = React.useCallback(
        (i: number, patch: Partial<Draft>) => {
            setDraft(prev =>
                prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d))
            )
        },
        []
    )

    const swap = React.useCallback((i: number, j: number) => {
        setDraft(prev => {
            if (i < 0 || j < 0 || i >= prev.length || j >= prev.length)
                return prev
            const next = [...prev]
            ;[next[i], next[j]] = [next[j], next[i]]
            return next
        })
    }, [])

    const removeAt = React.useCallback((i: number) => {
        setDraft(prev => prev.filter((_, idx) => idx !== i))
    }, [])

    const addRule = React.useCallback(() => {
        setDraft(prev => [...prev, emptyDraft()])
    }, [])

    const onSave = React.useCallback(async () => {
        if (sourceId === null || snapshot === null) return
        setSaving(true)
        setError(null)
        try {
            const effective = draft.filter(isMeaningful)

            const keptRids = new Set(
                effective.filter(d => d.rid !== 0).map(d => d.rid)
            )
            for (const orig of snapshot) {
                if (!keptRids.has(orig.rid)) {
                    await rulesApi.delete(orig.rid)
                }
            }

            for (let i = 0; i < effective.length; i++) {
                const d = effective[i]
                if (d.rid === 0) {
                    const input: NewRule = {
                        sourceId,
                        position: i,
                        filterTypeMask: d.filterTypeMask,
                        filterSearch: d.filterSearch,
                        filterMatch: d.filterMatch,
                        actionRead: d.actionRead,
                        actionStar: d.actionStar,
                        actionHide: d.actionHide,
                        actionNotify: d.actionNotify,
                    }
                    await rulesApi.create(input)
                } else {
                    const orig = snapshot.find(r => r.rid === d.rid)
                    const fieldsChanged =
                        !orig || !draftsEqualIgnoringPosition(ruleToDraft(orig), d)
                    const positionChanged = !orig || orig.position !== i
                    if (fieldsChanged || positionChanged) {
                        const patch: RulePatch = {
                            position: i,
                            filterTypeMask: d.filterTypeMask,
                            filterSearch: d.filterSearch,
                            filterMatch: d.filterMatch,
                            actionRead: d.actionRead,
                            actionStar: d.actionStar,
                            actionHide: d.actionHide,
                            actionNotify: d.actionNotify,
                        }
                        await rulesApi.update(d.rid, patch)
                    }
                }
            }

            onChanged?.()
            onClose()
        } catch (e) {
            setError("Save failed: " + String((e as Error)?.message ?? e))
        } finally {
            setSaving(false)
        }
    }, [draft, snapshot, sourceId, onChanged, onClose])

    if (sourceId === null) return null

    return (
        <div className={styles.overlay} onClick={onClose}>
            <div className={styles.panel} onClick={e => e.stopPropagation()}>
                <div className={styles.header}>
                    <span className={styles.title}>
                        Rules for {sourceName || "(source)"}
                    </span>
                    <button
                        className={`${styles.btn} ${styles.btnSecondary}`}
                        onClick={onClose}
                        disabled={saving}>
                        Close
                    </button>
                </div>

                <div className={styles.body}>
                    {snapshot === null ? (
                        <div>Loading…</div>
                    ) : (
                        <>
                            <div className={styles.hint}>
                                Rules apply to newly-fetched items only. Existing
                                articles are not affected.
                            </div>
                            {draft.length === 0 && (
                                <div className={styles.emptyState}>
                                    No rules yet. Click "+ Add rule" to create
                                    one.
                                </div>
                            )}
                            {draft.map((d, i) => (
                                <RuleCard
                                    key={d.rid !== 0 ? `r-${d.rid}` : `n-${i}`}
                                    d={d}
                                    index={i}
                                    canMoveUp={i > 0}
                                    canMoveDown={i < draft.length - 1}
                                    onChange={patch => updateAt(i, patch)}
                                    onMoveUp={() => swap(i, i - 1)}
                                    onMoveDown={() => swap(i, i + 1)}
                                    onDelete={() => removeAt(i)}
                                />
                            ))}
                            <button
                                className={styles.addBtn}
                                onClick={addRule}
                                disabled={saving}>
                                + Add rule
                            </button>
                            {error && (
                                <div className={styles.errorMessage}>{error}</div>
                            )}
                        </>
                    )}
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
                        disabled={snapshot === null || saving}>
                        {saving ? "Saving…" : "Save"}
                    </button>
                </div>
            </div>
        </div>
    )
}

interface RuleCardProps {
    d: Draft
    index: number
    canMoveUp: boolean
    canMoveDown: boolean
    onChange: (patch: Partial<Draft>) => void
    onMoveUp: () => void
    onMoveDown: () => void
    onDelete: () => void
}

function RuleCard(props: RuleCardProps): React.ReactElement {
    const {
        d,
        canMoveUp,
        canMoveDown,
        onChange,
        onMoveUp,
        onMoveDown,
        onDelete,
    } = props

    const toggleMask = (bit: number, on: boolean): void => {
        const next = on ? d.filterTypeMask | bit : d.filterTypeMask & ~bit
        onChange({ filterTypeMask: next })
    }

    return (
        <div className={styles.ruleCard}>
            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>Filter text</span>
                <input
                    className={styles.input}
                    type="text"
                    value={d.filterSearch}
                    placeholder="e.g. rust"
                    onChange={e => onChange({ filterSearch: e.target.value })}
                />
            </div>

            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>Search in</span>
                <div className={styles.checkGroup}>
                    <label className={styles.check}>
                        <input
                            type="checkbox"
                            checked={(d.filterTypeMask & MASK_TITLE) !== 0}
                            onChange={e => toggleMask(MASK_TITLE, e.target.checked)}
                        />
                        Title
                    </label>
                    <label className={styles.check}>
                        <input
                            type="checkbox"
                            checked={(d.filterTypeMask & MASK_SNIPPET) !== 0}
                            onChange={e =>
                                toggleMask(MASK_SNIPPET, e.target.checked)
                            }
                        />
                        Snippet
                    </label>
                    <label className={styles.check}>
                        <input
                            type="checkbox"
                            checked={(d.filterTypeMask & MASK_CREATOR) !== 0}
                            onChange={e =>
                                toggleMask(MASK_CREATOR, e.target.checked)
                            }
                        />
                        Creator
                    </label>
                </div>
            </div>

            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>Mode</span>
                <div className={styles.radioGroup}>
                    <label className={styles.radio}>
                        <input
                            type="radio"
                            checked={d.filterMatch}
                            onChange={() => onChange({ filterMatch: true })}
                        />
                        Match
                    </label>
                    <label className={styles.radio}>
                        <input
                            type="radio"
                            checked={!d.filterMatch}
                            onChange={() => onChange({ filterMatch: false })}
                        />
                        Doesn't match
                    </label>
                </div>
            </div>

            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>Actions</span>
                <div className={styles.actionsGrid}>
                    <ActionSelect
                        label="Read"
                        value={d.actionRead}
                        onChange={v => onChange({ actionRead: v })}
                    />
                    <ActionSelect
                        label="Star"
                        value={d.actionStar}
                        onChange={v => onChange({ actionStar: v })}
                    />
                    <ActionSelect
                        label="Hide"
                        value={d.actionHide}
                        onChange={v => onChange({ actionHide: v })}
                    />
                    <ActionSelect
                        label="Notify"
                        value={d.actionNotify}
                        onChange={v => onChange({ actionNotify: v })}
                    />
                </div>
            </div>

            <div className={styles.cardFooter}>
                <button
                    className={styles.iconBtn}
                    onClick={onMoveUp}
                    disabled={!canMoveUp}
                    title="Move up">
                    ↑
                </button>
                <button
                    className={styles.iconBtn}
                    onClick={onMoveDown}
                    disabled={!canMoveDown}
                    title="Move down">
                    ↓
                </button>
                <button
                    className={styles.deleteBtn}
                    onClick={onDelete}
                    title="Delete">
                    Delete
                </button>
            </div>
        </div>
    )
}

interface ActionSelectProps {
    label: string
    value: number | null
    onChange: (v: number | null) => void
}

function ActionSelect(props: ActionSelectProps): React.ReactElement {
    const { label, value, onChange } = props
    return (
        <label className={styles.actionLabel}>
            {label}
            <select
                value={value === null ? "" : String(value)}
                onChange={e => {
                    const v = e.target.value
                    onChange(v === "" ? null : Number(v))
                }}>
                <option value="">Don't change</option>
                <option value="1">Set to true</option>
                <option value="0">Set to false</option>
            </select>
        </label>
    )
}
