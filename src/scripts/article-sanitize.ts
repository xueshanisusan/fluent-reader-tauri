import sanitizeHtml from "sanitize-html"

// SECURITY: do NOT add "style" — sanitize-html validates inline style="..." against
// ALLOWED_STYLES below but does NOT parse <style> tag *contents*, so allowing the tag
// would re-open CSS-based exfil / overlay attacks (@import, position:fixed, etc.).
const ALLOWED_TAGS = [
    "p", "br", "hr",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "em", "b", "i", "u", "s", "sub", "sup", "small", "mark",
    "code", "pre", "kbd", "samp", "var",
    "blockquote", "cite", "q",
    "ul", "ol", "li", "dl", "dt", "dd",
    "a", "img", "figure", "figcaption",
    "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
    "div", "span", "section", "article", "aside", "header", "footer", "nav", "main",
    "time", "abbr", "data", "address",
]

const ALLOWED_ATTRS: sanitizeHtml.IOptions["allowedAttributes"] = {
    "*":        ["class", "id", "dir", "lang", "title", "style"],
    a:          ["href", "rel", "name"],
    img:        ["src", "alt", "width", "height"],
    td:         ["colspan", "rowspan", "align"],
    th:         ["colspan", "rowspan", "align", "scope"],
    col:        ["span"],
    colgroup:   ["span"],
    time:       ["datetime"],
    abbr:       ["title"],
    blockquote: ["cite"],
    q:          ["cite"],
}

const ALLOWED_SCHEMES = ["http", "https", "mailto"]
const ALLOWED_SCHEMES_BY_TAG: sanitizeHtml.IOptions["allowedSchemesByTag"] = {
    img: ["http", "https", "data"],
}

// CSS allowlist — typographic only. Background-image / content / cursor / position /
// animation / transition / transform / url(*) intentionally excluded to block CSS
// exfiltration via :hover { background: url(evil) } side channel.
const ALLOWED_STYLES: sanitizeHtml.IOptions["allowedStyles"] = {
    "*": {
        color: [
            /^#(?:[0-9a-f]{3}){1,2}$/i,
            /^rgba?\([\d.,\s%]+\)$/i,
            /^hsla?\([\d.,\s%]+\)$/i,
            /^[a-z]+$/i,
        ],
        "background-color": [
            /^#(?:[0-9a-f]{3}){1,2}$/i,
            /^rgba?\([\d.,\s%]+\)$/i,
            /^hsla?\([\d.,\s%]+\)$/i,
            /^[a-z]+$/i,
        ],
        "text-align":      [/^(left|right|center|justify|start|end)$/],
        "text-decoration": [/^(none|underline|line-through|overline)$/],
        "font-size":       [/^\d+(\.\d+)?(px|em|rem|%)$/],
        "font-weight":     [/^(normal|bold|bolder|lighter|[1-9]00)$/],
        "font-style":      [/^(normal|italic|oblique)$/],
        "font-family":     [/^[a-zA-Z0-9 ,'"\-]+$/],
        "line-height":     [/^\d+(\.\d+)?(px|em|rem|%)?$/],
        "letter-spacing":  [/^-?\d+(\.\d+)?(px|em|rem)$/],
        margin:            [/^(auto|-?\d+(\.\d+)?(px|em|rem|%)(\s+(auto|-?\d+(\.\d+)?(px|em|rem|%))){0,3})$/],
        padding:           [/^(\d+(\.\d+)?(px|em|rem|%)(\s+\d+(\.\d+)?(px|em|rem|%)){0,3})$/],
        width:             [/^\d+(\.\d+)?(px|em|rem|%)$/, /^auto$/],
        "max-width":       [/^\d+(\.\d+)?(px|em|rem|%)$/],
    },
}

export function sanitize(html: string): string {
    return sanitizeHtml(html, {
        allowedTags: ALLOWED_TAGS,
        allowedAttributes: ALLOWED_ATTRS,
        allowedSchemes: ALLOWED_SCHEMES,
        allowedSchemesByTag: ALLOWED_SCHEMES_BY_TAG,
        allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
        allowProtocolRelative: false,
        allowedStyles: ALLOWED_STYLES,
        disallowedTagsMode: "discard",
        transformTags: {
            a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }, true),
        },
    })
}
