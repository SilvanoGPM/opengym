// Just enough Markdown to read a coaching answer.
//
// Nothing in openGym rendered Markdown before this — notes are plain text, and there is no
// `dangerouslySetInnerHTML` anywhere in the app. That is worth keeping: this text comes from a
// language model, which means it is untrusted input that happens to be about squats. So this
// parses to a STRUCTURE and hands that to JSX, rather than producing an HTML string. There is
// no path from a model's output to innerHTML, by construction rather than by escaping carefully.
//
// Headings, bullets, numbered lists, bold and inline code. Not a Markdown implementation —
// a model asked for those five things produces those five things, and a link or a table
// arriving as its literal characters is a far better failure than a parser worth its own
// bug reports.

const H = /^(#{1,4})\s+(.*)$/
const UL = /^\s*[-*•]\s+(.*)$/
const OL = /^\s*(\d+)[.)]\s+(.*)$/

/**
 * Inline runs of a line: bold (**x** or __x__) and code (`x`).
 * @returns {Array<{text: string, bold?: boolean, code?: boolean}>}
 */
export function spansOf(line) {
  const out = []
  // One pass, one regex: alternating the two forms keeps them from nesting into each other,
  // which is the only interaction worth caring about at this size.
  const re = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`/g
  let last = 0
  let m
  while ((m = re.exec(line))) {
    if (m.index > last) out.push({ text: line.slice(last, m.index) })
    if (m[3] != null) out.push({ text: m[3], code: true })
    else out.push({ text: m[1] ?? m[2], bold: true })
    last = re.lastIndex
  }
  if (last < line.length) out.push({ text: line.slice(last) })
  return out.length ? out : [{ text: '' }]
}

/**
 * @returns {Array<{type:'h',level:number,spans:Array}|{type:'p',spans:Array}|{type:'ul'|'ol',items:Array<Array>}>}
 */
export function parseMarkdown(src) {
  const blocks = []
  let para = []
  let list = null

  const flushPara = () => {
    if (!para.length) return
    blocks.push({ type: 'p', spans: spansOf(para.join(' ')) })
    para = []
  }
  const flushList = () => {
    if (list) blocks.push(list)
    list = null
  }

  for (const raw of String(src == null ? '' : src).split('\n')) {
    const line = raw.replace(/\s+$/, '')

    if (!line.trim()) { flushPara(); flushList(); continue }

    const h = H.exec(line)
    if (h) {
      flushPara(); flushList()
      blocks.push({ type: 'h', level: h[1].length, spans: spansOf(h[2]) })
      continue
    }

    const ul = UL.exec(line)
    const ol = ul ? null : OL.exec(line)
    if (ul || ol) {
      flushPara()
      const type = ul ? 'ul' : 'ol'
      // A bullet list running straight into a numbered one is two lists, not one confused list.
      if (!list || list.type !== type) { flushList(); list = { type, items: [] } }
      list.items.push(spansOf(ul ? ul[1] : ol[2]))
      continue
    }

    flushList()
    para.push(line.trim())
  }
  flushPara()
  flushList()
  return blocks
}
