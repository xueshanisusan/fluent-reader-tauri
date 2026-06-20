import * as React from "react"
import type { Group, Source } from "../../scripts/db-bridge"
import { SourceRow } from "./SourceRow"
import { GroupRow } from "./GroupRow"
import { SourceContextMenu } from "./SourceContextMenu"
import styles from "./Sidebar.module.css"

export interface SidebarProps {
    sources: Source[]
    groups: Group[]
    unreadCounts: ReadonlyMap<number, number>
    selectedSourceId: number | null
    expandedGroups: ReadonlySet<number>
    onSelectSource: (sid: number | null) => void
    onToggleGroup: (gid: number, expanded: boolean) => void
    onRenameSource: (sid: number, name: string) => void
    onEditRules: (sid: number) => void
    onDeleteSource: (s: Source) => void
}

interface ContextMenuState {
    sid: number
    x: number
    y: number
}

export function Sidebar(props: SidebarProps): React.ReactElement {
    const {
        sources,
        groups,
        unreadCounts,
        selectedSourceId,
        expandedGroups,
        onSelectSource,
        onToggleGroup,
        onRenameSource,
        onEditRules,
        onDeleteSource,
    } = props

    const [contextMenu, setContextMenu] = React.useState<ContextMenuState | null>(
        null
    )
    const [renamingSid, setRenamingSid] = React.useState<number | null>(null)

    const totalUnread = React.useMemo(() => {
        let n = 0
        for (const v of unreadCounts.values()) n += v
        return n
    }, [unreadCounts])

    const ungrouped = sources.filter(s => s.groupId === null)
    const byGroup = new Map<number, Source[]>()
    for (const s of sources) {
        if (s.groupId === null) continue
        const arr = byGroup.get(s.groupId) ?? []
        arr.push(s)
        byGroup.set(s.groupId, arr)
    }

    const groupUnread = (gid: number): number => {
        const children = byGroup.get(gid) ?? []
        let n = 0
        for (const c of children) n += unreadCounts.get(c.sid) ?? 0
        return n
    }

    const allActive = selectedSourceId === null
    const allRowClass = allActive ? `${styles.row} ${styles.active}` : styles.row

    const lookupSource = (sid: number): Source | undefined =>
        sources.find(s => s.sid === sid)

    const renderSource = (s: Source): React.ReactElement => (
        <SourceRow
            key={s.sid}
            source={s}
            active={selectedSourceId === s.sid}
            unread={unreadCounts.get(s.sid) ?? 0}
            renaming={renamingSid === s.sid}
            onSelect={() => onSelectSource(s.sid)}
            onContextMenu={e =>
                setContextMenu({ sid: s.sid, x: e.clientX, y: e.clientY })
            }
            onCommitRename={name => {
                onRenameSource(s.sid, name)
                setRenamingSid(null)
            }}
            onCancelRename={() => setRenamingSid(null)}
        />
    )

    return (
        <div className={styles.sidebar}>
            <div className={allRowClass} onClick={() => onSelectSource(null)}>
                <span className={styles.label}>All</span>
                {totalUnread > 0 && (
                    <span className={styles.badge}>{totalUnread}</span>
                )}
            </div>

            {ungrouped.length > 0 && (
                <>
                    <div className={styles.sectionHeader}>Ungrouped</div>
                    {ungrouped.map(renderSource)}
                </>
            )}

            {groups.map(g => {
                const expanded = expandedGroups.has(g.gid)
                const children = byGroup.get(g.gid) ?? []
                return (
                    <GroupRow
                        key={g.gid}
                        name={g.name}
                        expanded={expanded}
                        unread={groupUnread(g.gid)}
                        onToggleExpand={() => onToggleGroup(g.gid, !expanded)}>
                        {children.map(renderSource)}
                    </GroupRow>
                )
            })}

            {contextMenu && (
                <SourceContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    onRename={() => {
                        setRenamingSid(contextMenu.sid)
                        setContextMenu(null)
                    }}
                    onEditRules={() => {
                        const sid = contextMenu.sid
                        setContextMenu(null)
                        onEditRules(sid)
                    }}
                    onDelete={() => {
                        const s = lookupSource(contextMenu.sid)
                        setContextMenu(null)
                        if (s) onDeleteSource(s)
                    }}
                    onDismiss={() => setContextMenu(null)}
                />
            )}
        </div>
    )
}
