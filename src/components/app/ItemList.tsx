import * as React from "react"
import type { Item } from "../../scripts/db-bridge"
import { ViewType, isGridView } from "../../scripts/settings-bridge"
import { CardInfo } from "./CardInfo"
import styles from "./ItemList.module.css"

export interface SourceMeta {
    name: string
    iconUrl: string | null
}

export interface ItemListProps {
    items: Item[]
    selectedIid: number | null
    viewMode: ViewType
    sources?: ReadonlyMap<number, SourceMeta>
    onSelect: (it: Item) => void
}

function containerClass(viewMode: ViewType): string {
    if (viewMode === ViewType.Magazine) return styles.containerMagazine
    if (isGridView(viewMode)) return styles.containerCards
    return styles.container
}

export function ItemList(props: ItemListProps): React.ReactElement {
    const { items, selectedIid, viewMode, sources, onSelect } = props
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
                                source={sources?.get(it.sourceId)}
                                onSelect={onSelect}
                            />
                        )
                    case ViewType.Magazine:
                        return (
                            <MagazineRow
                                key={it.iid}
                                item={it}
                                selected={selected}
                                source={sources?.get(it.sourceId)}
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
                                source={sources?.get(it.sourceId)}
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
    source?: SourceMeta
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

// Faithful port of the original .list-card: an 80×80 thumb (when present) on
// the left + a data column (shared CardInfo meta line, title clamped to 3
// lines, snippet clamped to 2 lines). Renders in the 280px item column, so the
// data column is tighter than the original's full-width list — clamping keeps
// it tidy. Read cards fade title→--text-secondary, snippet→--text-muted.
// Selected shows a 2px left accent plus a subtle row tint. The original
// list-card uses plain <CardInfo> (no creator); the star lives in CardInfo.
function ListRow(props: RowProps): React.ReactElement {
    const { item, selected, source, onSelect } = props
    const [imgOk, setImgOk] = React.useState(true)
    const showThumb = !!item.thumb && imgOk
    const cls = [
        styles.listCard,
        item.hasRead ? styles.read : "",
        selected ? styles.selected : "",
    ]
        .filter(Boolean)
        .join(" ")
    return (
        <div className={cls} onClick={() => onSelect(item)}>
            {showThumb && (
                <div className={styles.listHead}>
                    <img
                        src={item.thumb!}
                        alt=""
                        loading="lazy"
                        onError={() => setImgOk(false)}
                    />
                </div>
            )}
            <div className={styles.listData}>
                <CardInfo
                    className={styles.listInfo}
                    name={source?.name}
                    iconUrl={source?.iconUrl}
                    creator={item.creator}
                    starred={item.starred}
                    hasRead={item.hasRead}
                    dateMs={item.dateMs}
                />
                <h3 className={styles.listTitle}>{item.title}</h3>
                {item.snippet && (
                    <p className={styles.listSnippet}>{item.snippet}</p>
                )}
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

// Faithful port of the original default-card (fixed 256×264 tile). With a
// cover image: blurred backdrop + frosted overlay + 144px cover on top + info
// + title (no snippet — no room without the hover slide we deliberately skip).
// Without an image (the common case for text feeds): info + title + a long
// snippet filling the card.
function CardsRow(props: RowProps): React.ReactElement {
    const { item, source, onSelect } = props
    const [imgOk, setImgOk] = React.useState(true)
    const showThumb = !!item.thumb && imgOk
    return (
        <div
            className={`${styles.card} ${styles.defaultCard}`}
            onClick={() => onSelect(item)}>
            {showThumb && (
                <img
                    className={styles.bgImg}
                    src={item.thumb!}
                    alt=""
                    aria-hidden="true"
                    onError={() => setImgOk(false)}
                />
            )}
            {showThumb && <div className={styles.bgOverlay} />}
            {showThumb && (
                <img
                    className={styles.head}
                    src={item.thumb!}
                    alt=""
                    loading="lazy"
                />
            )}
            <CardInfo
                name={source?.name}
                iconUrl={source?.iconUrl}
                creator={item.creator}
                starred={item.starred}
                hasRead={item.hasRead}
                dateMs={item.dateMs}
            />
            <h3 className={styles.cardTitle}>{item.title}</h3>
            {!showThumb && item.snippet && (
                <p className={styles.cardSnippet}>{item.snippet}</p>
            )}
        </div>
    )
}

// Faithful port of the original .magazine-card: a fixed 700px-wide card,
// 200×160 cover on the left, data column on the right (title + snippet + the
// shared CardInfo meta line with creator). Read cards fade their text; no hover
// slide (the original magazine-card has none). The star lives in CardInfo, like
// the original — there is no separate title star.
function MagazineRow(props: RowProps): React.ReactElement {
    const { item, selected, source, onSelect } = props
    const [imgOk, setImgOk] = React.useState(true)
    const showThumb = !!item.thumb && imgOk
    const cls = [
        styles.magazineCard,
        item.hasRead ? styles.read : "",
        selected ? styles.selected : "",
    ]
        .filter(Boolean)
        .join(" ")
    return (
        <div className={cls} onClick={() => onSelect(item)}>
            {showThumb && (
                <div className={styles.magHead}>
                    <img
                        src={item.thumb!}
                        alt=""
                        loading="lazy"
                        onError={() => setImgOk(false)}
                    />
                </div>
            )}
            <div className={styles.magData}>
                <div className={styles.magText}>
                    <h3 className={styles.magTitle}>{item.title}</h3>
                    {item.snippet && (
                        <p className={styles.magSnippet}>{item.snippet}</p>
                    )}
                </div>
                <CardInfo
                    className={styles.magInfo}
                    name={source?.name}
                    iconUrl={source?.iconUrl}
                    creator={item.creator}
                    starred={item.starred}
                    hasRead={item.hasRead}
                    dateMs={item.dateMs}
                    showCreator
                />
            </div>
        </div>
    )
}
