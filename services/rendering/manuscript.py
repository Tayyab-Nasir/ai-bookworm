"""Safe, deterministic inline formatting and list structure shared by exporters."""
from html import escape
from math import isfinite

MARKS = {"bold", "italic", "strike", "code", "underline"}


def table_rows(node: dict) -> list[list[str]]:
    """Ignore malformed or stale grids instead of hiding a later canonical edit."""
    rows = node.get("rows")
    if not isinstance(rows, list) or not all(isinstance(row, list) and all(isinstance(cell, str) for cell in row) for row in rows):
        return []
    text = "\n".join("\t".join(row) for row in rows)
    return rows if node.get("text") in (None, text) else []


def inline_runs(node: dict) -> list[dict]:
    text = node.get("text") or ""
    attrs = node.get("attributes")
    stored = attrs.get("richText") if isinstance(attrs, dict) else None
    runs = []
    for part in stored if isinstance(stored, list) else []:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "hardBreak":
            runs.append({"text": "\n", "marks": []})
        elif part.get("type") == "text" and isinstance(part.get("text"), str):
            raw_marks = part.get("marks")
            marks = {m.get("type") for m in raw_marks if isinstance(m, dict) and isinstance(m.get("type"), str)} if isinstance(raw_marks, list) else set()
            runs.append({"text": part["text"], "marks": sorted(marks & MARKS)})
    return runs if "".join(run["text"] for run in runs) == text else [{"text": text, "marks": []}]


def inline_markup(node: dict, *, pdf: bool = False, pdf_code_font: str = "Courier") -> str:
    tags = {"bold": ("b", "b"), "italic": ("i", "i"), "strike": ("strike", "strike"),
            "underline": ("u", "u"), "code": (f'font name="{escape(pdf_code_font, quote=True)}"', "font")} if pdf else {
                "bold": ("strong", "strong"), "italic": ("em", "em"), "strike": ("s", "s"),
                "underline": ("u", "u"), "code": ("code", "code")}
    output = []
    for run in inline_runs(node):
        value = escape(run["text"]).replace("\n", "<br/>")
        # The embedded code family must wrap bold/italic, not reset an outer
        # italic tag. Keep historical Courier markup unchanged for old editions.
        marks = sorted(run["marks"], key=lambda mark: mark == "code") if pdf and pdf_code_font != "Courier" else run["marks"]
        for mark in marks:
            start, end = tags[mark]
            value = f"<{start}>{value}</{end}>"
        output.append(value)
    return "".join(output)


def image_width(node: dict) -> int:
    attrs = node.get("attributes")
    value = attrs.get("widthPercent", 100) if isinstance(attrs, dict) else 100
    return min(100, max(25, round(value))) if type(value) in (int, float) and isfinite(value) else 100


def image_print_placement(node: dict) -> str:
    attrs = node.get("attributes")
    return "fullBleed" if isinstance(attrs, dict) and attrs.get("printPlacement") == "fullBleed" else "inline"


def image_focal_point(node: dict) -> tuple[float, float]:
    attrs = node.get("attributes")
    if not isinstance(attrs, dict):
        return 0.5, 0.5
    values = []
    for key in ("printFocalX", "printFocalY"):
        value = attrs.get(key, 50)
        values.append(min(100, max(0, float(value))) / 100 if type(value) in (int, float) and isfinite(value) else 0.5)
    return values[0], values[1]


def block_tree(nodes: list[dict]) -> list[dict]:
    """Group flat canonical list items, retaining mixed nesting without HTML input."""
    result = []
    lists = []
    for node in nodes:
        if node.get("type") != "listItem":
            lists.clear()
            result.append({"node": node})
            continue
        attrs = node.get("attributes") or {}
        raw_depth = attrs.get("listDepth", 0)
        depth = min(max(0, int(raw_depth)), len(lists), 6) if type(raw_depth) in (int, float) and isfinite(raw_depth) else 0
        style = "ordered" if attrs.get("listStyle") == "ordered" else "bullet"
        lists = lists[:depth + 1]
        if len(lists) <= depth or lists[depth]["style"] != style:
            group = {"style": style, "items": []}
            if depth:
                lists[depth - 1]["items"][-1]["children"].append(group)
            else:
                result.append(group)
            lists = lists[:depth] + [group]
        lists[depth]["items"].append({"node": node, "children": []})
    return result
