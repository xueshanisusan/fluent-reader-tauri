import * as React from "react"
import type { Item } from "../../scripts/db-bridge"
import { ViewType, isGridView } from "../../scripts/settings-bridge"
import styles from "./ItemList.module.css"

export interface ItemListProps {
    items: Item[]
    selectedIid: number | null
    viewMode: ViewType
    onSelect: (it: Item) => void
}

function containerClass(viewMode: ViewType): string {
    if (viewMode === ViewType.Magazine) return styles.containerMagazine
    if (isGridView(viewMode)) return styles.containerCards
    return styles.container
}

export function ItemList(props: ItemListProps): React.ReactElement {
    const { items, selectedIid, viewMode, onSelect } = props
    return (
        <div className={containerClass(viewMode)}>
            {items.map(it => {
                const selected = selectedIid === it.iid
                switch (viewMode) {
                    case ViewType.Compact:
                        return (
                            <CompactRow
                                key={it.iid}
                                item={it}
                                selected={selected}
                                onSelect={onSelect}
                            />
                        )
                    case ViewType.List:
                        return (
                            <ListRow
                                key={it.iid}
                                item={it}
                                selected={selected}
                                onSelect={onSelect}
                            />
                        )
                    case ViewType.Magazine:
                        return (
                            <MagazineRow
                                key={it.iid}
                                item={it}
                                selected={selected}
                                onSelect={onSelect}
                            />
                        )
                    case ViewType.Cards:
                    case ViewType.Customized:
                    default:
                        return (
                            <CardsRow
                                key={it.iid}
                                item={it}
                                selected={selected}
                                onSelect={onSelect}
                            />
                        )
                }
            })}
        </div>
    )
}

interface RowProps {
    item: Item
    selected: boolean
    onSelect: (it: Item) => void
}

function rowClass(base: string, item: Item, selected: boolean): string {
    return [
        styles.row,
        base,
        item.hasRead ? styles.read : "",
        selected ? styles.selected : "",
    ]
        .filter(Boolean)
        .join(" ")
}

function ListRow(props: RowProps): React.ReactElement {
    const { item, selected, onSelect } = props
    return (
        <div
            className={rowClass(styles.rowList, item, selected)}
            onClick={() => onSelect(item)}>
            <div className={styles.title}>
                {item.title}
                {item.starred && <span className={styles.star}>★</span>}
            </div>
            <div className={styles.date}>
                {new Date(item.dateMs).toLocaleString()}
            </div>
        </div>
    )
}

function CompactRow(props: RowProps): React.ReactElement {
    const { item, selected, onSelect } = props
    return (
        <div
            className={rowClass(styles.rowCompact, item, selected)}
            onClick={() => onSelect(item)}>
            <div className={styles.title}>
                {item.title}
                {item.starred && <span className={styles.star}>★</span>}
            </div>
            <div className={styles.date}>
                {new Date(item.dateMs).toLocaleDateString()}
            </div>
        </div>
    )
}

function CardsRow(props: RowProps): React.ReactElement {
    const { item, selected, onSelect } = props
    const [imgOk, setImgOk] = React.useState(true)
    const showThumb = !!item.thumb && imgOk
    return (
        <div
            className={rowClass(styles.rowCard, item, selected)}
            onClick={() => onSelect(item)}>
            {showThumb && (
                <img
                    className={styles.thumb}
                    src={item.thumb!}
                    alt=""
                    loading="lazy"
                    onError={() => setImgOk(false)}
                />
            )}
            <div className={styles.title}>
                {item.title}
                {item.starred && <span className={styles.star}>★</span>}
            </div>
            {item.snippet && (
                <div className={styles.snippet}>{item.snippet}</div>
            )}
            <div className={styles.date}>
                {new Date(item.dateMs).toLocaleString()}
            </div>
        </div>
    )
}

function MagazineRow(props: RowProps): React.ReactElement {
    const { item, selected, onSelect } = props
    const [imgOk, setImgOk] = React.useState(true)
    const showThumb = !!item.thumb && imgOk
    return (
        <div
            className={rowClass(styles.rowMagazine, item, selected)}
            onClick={() => onSelect(item)}>
            {showThumb && (
                <img
                    className={styles.magThumb}
                    src={item.thumb!}
                    alt=""
                    loading="lazy"
                    onError={() => setImgOk(false)}
                />
            )}
            <div className={styles.magBody}>
                <div className={styles.title}>
                    {item.title}
                    {item.starred && <span className={styles.star}>★</span>}
                </div>
                {item.snippet && (
                    <div className={styles.magSnippet}>{item.snippet}</div>
                )}
                <div className={styles.date}>
                    {new Date(item.dateMs).toLocaleString()}
                </div>
            </div>
        </div>
    )
}
