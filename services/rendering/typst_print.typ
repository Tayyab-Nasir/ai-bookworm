// Typesetting instructions are trusted. Manuscript values enter only as JSON.
#let m = json("book.json")
#let t = m.typography
#let p = m.page
#let n = m.numbering
#let direction = if m.rtl { rtl } else { ltr }
#let body-weight = if t.body_font.ends-with("-Bold") { "bold" } else { "regular" }
#let heading-weight = if t.heading_font.ends-with("-Bold") { "bold" } else { "regular" }
#let number-style = if n.style == "roman" { "i" } else { "1" }
#let body-width = p.trim_width - p.inner - p.outer
#let body-height = p.height - 2 * p.outer_bleed - p.top - p.bottom

#set document(title: m.title, author: m.author, description: m.subject)
#set text(font: "Amiri", fallback: false, dir: direction, lang: m.language,
  weight: body-weight, size: t.body_size_pt * 1pt, hyphenate: false,
  top-edge: 0.8em, bottom-edge: -0.2em)
#set par(leading: (t.leading - t.body_size_pt) * 1pt, spacing: t.paragraph_spacing_pt * 1pt,
  first-line-indent: (amount: t.first_line_indent_in * 1in, all: true), justify: t.text_align == "justify")
#set align(if t.text_align == "left" { left } else { start })
#let folio = context {
  let physical = here().page()
  let label = text(size: 9pt, weight: "regular", dir: ltr, numbering(number-style, physical - 1 + n.start_at))
  let label-width = measure(label).width
  let inner-right = (calc.rem(physical, 2) == 1) == m.rtl
  let trim-left = if inner-right { p.outer_bleed } else { p.inner_bleed }
  let number-left = if n.position == "bottom-outer" {
    if inner-right { calc.max(p.outer, 36) * 1pt } else { (p.trim_width - calc.max(p.outer, 36)) * 1pt - label-width }
  } else { p.trim_width * 0.5pt - label-width / 2 }
  let safe-left = calc.max(if inner-right { p.outer } else { p.inner }, 36) * 1pt
  let safe-right = (p.trim_width - calc.max(if inner-right { p.inner } else { p.outer }, 36)) * 1pt
  assert(number-left >= safe-left and number-left + label-width <= safe-right, message: "Folio Outside Margins")
  let y = if n.position == "top-center" { (p.outer_bleed + 36) * 1pt } else { (p.height - p.outer_bleed - 45) * 1pt }
  place(top + left, dx: trim-left * 1pt + number-left, dy: y, label)
}
#set page(width: p.width * 1pt, height: p.height * 1pt,
  binding: if m.rtl { right } else { left }, numbering: number-style,
  header: none, footer: none, background: if n.style == "none" { none } else { folio },
  margin: (inside: (p.inner + p.inner_bleed) * 1pt, outside: (p.outer + p.outer_bleed) * 1pt,
           top: (p.top + p.outer_bleed) * 1pt, bottom: (p.bottom + p.outer_bleed) * 1pt))
#counter(page).update(n.start_at)

#let plain(value) = value.replace("\r\n", "\n").replace("\r", "\n").split("\n").map(piece => text(piece)).join(linebreak())
#let heading-text(content) = text(weight: heading-weight, size: t.heading_size_pt * 1pt, content)
#let without-indent(content) = par(first-line-indent: 0pt, justify: false, content)
#let inline(runs) = runs.map(run => {
  let content = plain(run.text)
  for mark in run.marks {
    content = if mark == "bold" { text(weight: "bold", content) }
    else if mark == "italic" { emph(content) }
    else if mark == "underline" { underline(content) }
    else if mark == "strike" { strike(content) }
    else if mark == "code" { text(font: "DejaVu Sans Mono", content) }
    else { content }
  }
  content
}).join()

#let artwork(path, width, height, alt) = image(read(path, encoding: none), width: width, height: height,
  alt: if alt == "" { none } else { alt })

#let render-block(b) = {
  if b.kind == "list" {
    let item-content(item) = without-indent(inline(item.runs)) + item.children.map(render-block).join()
    if b.numbered {
      let pattern = (decimal: "1.", lower-alpha: "a.", upper-alpha: "A.", lower-roman: "i.", upper-roman: "I.").at(b.style)
      enum(numbering: pattern, tight: false, ..b.items.map(item => enum.item(item.number, item-content(item))))
    } else {
      list(tight: false, ..b.items.map(item-content))
    }
  } else if b.kind == "table" {
    let cell(item) = table.cell(x: item.x, y: item.y, colspan: item.width, rowspan: item.height,
      fill: if item.y < b.header_rows { rgb("#e7e2d8") } else { none },
      text(weight: if item.y < b.header_rows { "bold" } else { body-weight }, without-indent(plain(item.text))))
    let cols = range(b.columns).map(i => 1fr)
    let headers = b.cells.filter(item => item.y < b.header_rows).map(cell)
    let body = b.cells.filter(item => item.y >= b.header_rows).map(cell)
    let cells = if headers.len() > 0 { (table.header(..headers),) + body } else { body }
    table(columns: cols, inset: 5pt, stroke: 0.4pt + rgb("#777777"), align: start + top, ..cells)
  } else if b.kind == "fullBleed" {
    page(margin: 0pt, background: none, header: none, footer: none,
      image(read(b.path, encoding: none), width: p.width * 1pt, height: p.height * 1pt, fit: "stretch",
            alt: if b.alt == "" { none } else { b.alt }))
  } else if b.kind == "image" {
    let width = calc.min(body-width * b.width, body-height * 0.65 * b.ratio)
    let caption = if b.caption == "" { none } else { without-indent(text(size: (t.body_size_pt - 1) * 1pt, plain(b.caption))) }
    block(breakable: false, align(center, artwork(b.path, width * 1pt, width / b.ratio * 1pt, b.alt)) + caption)
  } else if b.kind == "heading" {
    block(below: t.leading * 1pt, sticky: true, without-indent(heading-text(inline(b.runs))))
  } else if b.kind == "quote" {
    pad(x: 18pt, without-indent(inline(b.runs)))
  } else if b.kind == "caption" {
    without-indent(text(size: (t.body_size_pt - 1) * 1pt, inline(b.runs)))
  } else if b.kind == "pageBreak" {
    pagebreak()
  } else if b.kind == "separator" {
    v(t.leading * 1pt)
  } else {
    par(inline(b.runs))
  }
}

#block(below: t.leading * 1pt, without-indent(heading-text(plain(m.title))))
#for line in (m.subtitle, m.author).filter(value => value != "") { without-indent(plain(line)) }
#if m.copyright.len() > 0 {
  pagebreak()
  for line in m.copyright { without-indent(plain(line)) }
}
#if m.contents {
  pagebreak()
  let label = heading-text(if m.language == "ar" { "المحتويات" } else { "Contents" })
  if n.style == "none" {
    show outline.entry: entry => link(entry.element.location(), entry.body())
    outline(title: label, depth: 1)
  } else {
    outline(title: label, depth: 1)
  }
}
#let page-ended = false
#for chapter in m.chapters {
  if not page-ended { pagebreak() }
  heading(level: 1, outlined: true, bookmarked: m.bookmarks, numbering: none,
    heading-text(inline(chapter.title)))
  for b in chapter.blocks { render-block(b) }
  page-ended = chapter.blocks.len() > 0 and chapter.blocks.last().kind in ("pageBreak", "fullBleed")
}
