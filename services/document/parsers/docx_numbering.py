"""Resolve Word numbering from paragraph/style properties, never style names alone."""
from docx.oxml.ns import qn

from . import ParseError

_FORMATS = {"decimal": "decimal", "lowerLetter": "lower-alpha", "upperLetter": "upper-alpha",
            "lowerRoman": "lower-roman", "upperRoman": "upper-roman"}


def _value(element, name):
    child = element.find(qn("w:" + name)) if element is not None else None
    return child.get(qn("w:val")) if child is not None else None


def _integer(value, default, maximum=2_147_483_647):
    return int(value) if isinstance(value, str) and len(value) <= 10 and value.isascii() and value.isdecimal() and int(value) <= maximum else default


class WordNumbering:
    def __init__(self, doc, warnings):
        self.warnings = warnings
        try:
            root = doc.part.numbering_part.element
        except KeyError:
            root = []
        self.abstract = {el.get(qn("w:abstractNumId")): el for el in root if el.tag == qn("w:abstractNum")}
        self.numbers = {el.get(qn("w:numId")): el for el in root if el.tag == qn("w:num")}
        self.counters = {}
        self.definitions = {}

    def _definition(self, num_id, level):
        key = (num_id, level)
        if key in self.definitions:
            return self.definitions[key]
        num = self.numbers.get(num_id)
        abstract = self.abstract.get(_value(num, "abstractNumId"))
        definition = next((el for el in abstract if el.tag == qn("w:lvl") and el.get(qn("w:ilvl")) == str(level)), None) if abstract is not None else None
        override = next((el for el in num if el.tag == qn("w:lvlOverride") and el.get(qn("w:ilvl")) == str(level)), None) if num is not None else None
        replacement = override.find(qn("w:lvl")) if override is not None else None
        if replacement is not None:
            definition = replacement
        fmt = _value(definition, "numFmt")
        start_value = _value(override, "startOverride") or _value(definition, "start") or "1"
        start = _integer(start_value, None, 1_000_000)
        if start is None or start < 1:
            raise ParseError("DOCX list start must be an integer from 1 to 1000000; review numbering in the original")
        if definition is None:
            self.warnings.append("A DOCX numbering definition is missing; decimal list markers were substituted. Review against the original.")
        elif fmt not in {*_FORMATS, "bullet"}:
            self.warnings.append("An unsupported DOCX numbering format was normalized to decimal; review list markers against the original.")
        pattern = _value(definition, "lvlText")
        expected = "%" + str(level + 1)
        if fmt != "bullet" and pattern and pattern != expected + ".":
            self.warnings.append("DOCX compound/custom numbering labels were normalized; review their exact prefixes and suffixes against the original.")
        restart = _integer(_value(definition, "lvlRestart"), level)
        result = (fmt, start, restart)
        self.definitions[key] = result
        return result

    def attributes(self, paragraph):
        properties = [paragraph._p.pPr]
        style, seen = paragraph.style, set()
        while style is not None and style.style_id not in seen:
            seen.add(style.style_id)
            properties.append(style.element.pPr)
            style = style.base_style
        values = {}
        for properties_item in properties:
            num = properties_item.find(qn("w:numPr")) if properties_item is not None else None
            for name in ("numId", "ilvl"):
                value = _value(num, name)
                if name not in values and value is not None:
                    values[name] = value
        if "numId" not in values:
            return None
        num_id = values["numId"]
        if num_id == "0":
            return False  # Explicit Word suppression overrides inherited list styles.
        level = _integer(values.get("ilvl"), 0, 8)
        fmt, start, _ = self._definition(num_id, level)
        # Built-in List Bullet 2/3 styles use separate level-zero definitions.
        style_name = paragraph.style.name.lower() if paragraph.style is not None else ""
        suffix = style_name.rsplit(" ", 1)[-1]
        depth = level if "ilvl" in values else (int(suffix) - 1 if style_name.startswith("list") and suffix in {"2", "3"} else 0)
        if depth > 6:
            self.warnings.append("DOCX list nesting beyond seven levels was reduced; review indentation against the original.")
        attrs = {"listStyle": "bullet" if fmt == "bullet" else "ordered", "listDepth": min(6, depth)}
        counters = self.counters.setdefault(num_id, {})
        for child_level in list(counters):
            if child_level > level:
                _, _, restart = self._definition(num_id, child_level)
                if restart and level < restart:
                    del counters[child_level]
        current = counters.get(level, start - 1) + 1
        if current > 1_000_000:
            raise ParseError("DOCX list numbering exceeds safe import limit")
        counters[level] = current
        if fmt != "bullet":
            attrs.update(listStart=current, listNumberStyle=_FORMATS.get(fmt, "decimal"))
        return attrs
