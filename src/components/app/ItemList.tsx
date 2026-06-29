import * as React from "react"
import type { Item } from "../../scripts/db-bridge"
import { ViewType, ViewConfigs, isGridView } from "../../scripts/settings-bridge"
import { CardInfo } from "./CardInfo"
import { formatRelative } from "../../scripts/format"
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
    // Display toggles for the List view (cover/snippet/fade). Only ListRow
    // reads them — faithful to the original, which applies ViewConfigs to List
    // only. Defaults to ShowCover.
    listViewConfigs?: ViewConfigs
    onSelect: (it: Item) => void
}

function containerClass(viewMode: ViewType): string {
    if (viewMode === ViewType.Magazine) return styles.containerMagazine
    if (isGridView(viewMode)) return styles.containerCards
    return styles.container
}

export function ItemList(props: ItemListProps): React.ReactElement {
    const { items, selectedIid, viewMode, sources, listViewConfigs, onSelect } =
        props
    const configs = listViewConfigs ?? ViewConfigs.ShowCover
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
                                source={sources?.get(it.sourceId)}
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
                                configs={configs}
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
    // List view only; ignored by the other rows. Defaults to ShowCover.
    configs?: ViewConfigs
    onSelect: (it: Item) => void
}

// Faithful port of the original .list-card: an 80×80 thumb (when present) on
// the left + a data column (shared CardInfo meta line, title clamped to 3
// lines, snippet clamped to 2 lines), spanning the full-width feed. Read cards
// fade title→--text-secondary, snippet→--text-muted. Selected shows a 2px left
// accent plus a subtle row tint. The original list-card uses plain <CardInfo>
// (no creator); the star lives in CardInfo.
function ListRow(props: RowProps): React.ReactElement {
    const { item, selected, source, onSelect } = props
    const configs = props.configs ?? ViewConfigs.ShowCover
    const [imgOk, setImgOk] = React.useState(true)
    const showThumb =
        !!item.thumb && imgOk && !!(configs & ViewConfigs.ShowCover)
    const showSnippet = !!(configs & ViewConfigs.ShowSnippet) && !!item.snippet
    const fadeRead = !!(configs & ViewConfigs.FadeRead) && item.hasRead
    const cls = [
        styles.listCard,
        fadeRead ? styles.read : "",
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
                {showSnippet && (
                    <p className={styles.listSnippet}>{item.snippet}</p>
                )}
            </div>
        </div>
    )
}

// Faithful port of the original .compact-card: a 31px single-line row —
// CardInfo (fixed width, no time) on the left, an ellipsis-truncated run of
// bold title + muted snippet in the middle, and a trailing relative time on the
// right. No thumb, and (faithful to the original) no read fade — read state
// shows only via CardInfo's absent unread dot. The star lives in CardInfo.
function CompactRow(props: RowProps): React.ReactElement {
    const { item, selected, source, onSelect } = props
    const cls = [styles.compactCard, selected ? styles.selected : ""]
        .filter(Boolean)
        .join(" ")
    return (
        <div className={cls} onClick={() => onSelect(item)}>
            <CardInfo
                className={styles.compactInfo}
                name={source?.name}
                iconUrl={source?.iconUrl}
                creator={item.creator}
                starred={item.starred}
                hasRead={item.hasRead}
                dateMs={item.dateMs}
                hideTime
            />
            <div className={styles.compactData}>
                <span className={styles.compactTitle}>{item.title}</span>
                {item.snippet && (
                    <span className={styles.compactSnippet}>{item.snippet}</span>
                )}
            </div>
            <span className={styles.compactTime}>
                {formatRelative(item.dateMs)}
            </span>
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
