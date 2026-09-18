"""Core preflight rules v1.0.0 (PRD section 19 categories).

Generic, channel-agnostic checks. Values here follow public EPUB3 spec + common sense;
channel-specific thresholds live in the channel rule modules.
"""
from editions import language_requires_rtl_shaping, resolve_text_direction
from preflight import Finding, Rule, RuleSet, _LANG_RE, _meta, _open_epub
from print_fonts import BASE_FONTS, EMBEDDED_FONTS, print_font_issues
from editions import PrintEdition
from wrap_cover import validate_wrap_pdf

VERSION = "core-1.0.4"


def _find(code, msg, loc=""):
    return [Finding(code=code, message=msg, location=loc)]


# ---- package integrity ----------------------------------------------------

def check_book_model(ctx):
    book = ctx.get("book") or {}
    out = []
    if book.get("schemaVersion") != "1.0":
        out += _find("BOOK_SCHEMA", "book model schemaVersion must be 1.0", "book.schemaVersion")
    if not book.get("chapters"):
        out += _find("NO_CHAPTERS", "book has no chapters", "book.chapters")
    return out


def check_zip_readable(ctx):
    if ctx.get("artifact") is None:
        return []
    if _open_epub(ctx) is None:
        return _find("BAD_ZIP", "artifact is not a readable zip/epub", "artifact")
    return []


# ---- EPUB structure --------------------------------------------------------

def check_mimetype_first(ctx):
    zf = _open_epub(ctx)
    if zf is None:
        return []
    infos = zf.infolist()
    if not infos or infos[0].filename != "mimetype" or infos[0].compress_type != 0:
        return _find("MIMETYPE", "mimetype must be first zip entry, stored uncompressed", "mimetype")
    if zf.read("mimetype") != b"application/epub+zip":
        return _find("MIMETYPE_CONTENT", "mimetype content must be application/epub+zip", "mimetype")
    return []


def check_container(ctx):
    zf = _open_epub(ctx)
    if zf is None:
        return []
    names = set(zf.namelist())
    if "META-INF/container.xml" not in names:
        return _find("NO_CONTAINER", "META-INF/container.xml missing", "META-INF/container.xml")
    if "OEBPS/content.opf" not in names:
        return _find("NO_OPF", "OPF package document missing", "OEBPS/content.opf")
    return []


# ---- navigation / TOC -------------------------------------------------------

def check_nav(ctx):
    zf = _open_epub(ctx)
    if zf is None:
        return []
    if "OEBPS/nav.xhtml" not in set(zf.namelist()):
        return _find("NO_NAV", "EPUB3 nav document missing", "OEBPS/nav.xhtml")
    if b'epub:type="toc"' not in zf.read("OEBPS/nav.xhtml"):
        return _find("NO_TOC", "nav document lacks epub:type=toc", "OEBPS/nav.xhtml")
    return []


def check_chapter_titles(ctx):
    out = []
    for i, ch in enumerate(ctx["book"].get("chapters", [])):
        if not (ch.get("title") or "").strip():
            out += _find("CHAPTER_NO_TITLE", "chapter has no title (nav entry would be empty)",
                         f"book.chapters[{i}]")
    return out


# ---- metadata ---------------------------------------------------------------

def check_required_metadata(ctx):
    md = _meta(ctx)
    out = []
    if not (md.get("title") or "").strip():
        out += _find("NO_TITLE", "metadata.title is required", "book.metadata.title")
    if not (md.get("author") or "").strip():
        out += _find("NO_AUTHOR", "metadata.author is required", "book.metadata.author")
    return out


# ---- images -----------------------------------------------------------------

def check_image_sizes(ctx):
    """image_bytes: {assetId: bytes} provided by caller when asset content is available."""
    policy = ((ctx.get("edition") or {}).get("image_policy") or {})
    max_bytes = policy.get("max_bytes", 5 * 1024 * 1024)
    out = []
    for asset_id, data in sorted((ctx.get("image_bytes") or {}).items()):
        if len(data) > max_bytes:
            out += _find("IMAGE_TOO_LARGE",
                         f"image {asset_id} is {len(data)} bytes, policy max {max_bytes}",
                         f"asset:{asset_id}")
    return out


def check_image_refs(ctx):
    known = {a["id"] for a in ctx["book"].get("assets", [])}
    out = []
    for ch in ctx["book"].get("chapters", []):
        for n in ch.get("nodes", []):
            if n.get("type") == "image" and n.get("assetId") not in known:
                out += _find("IMAGE_REF_MISSING", "image node references unknown asset",
                             f"chapter:{ch['id']} node:{n['id']}")
    return out


# ---- fonts -------------------------------------------------------------------

def check_fonts_embedded(ctx):
    # Bundled Vera variants are embedded by the deterministic renderer.
    typo = ((ctx.get("edition") or {}).get("typography") or {})
    builtin = BASE_FONTS | EMBEDDED_FONTS
    out = []
    for key in ("body_font", "heading_font"):
        f = typo.get(key)
        if f and f not in builtin:
            out += _find("FONT_NOT_EMBEDDED",
                         f"font {f!r} is not a builtin; embedding + license check required",
                         f"edition.typography.{key}")
    return out


def check_print_glyphs(ctx):
    return [_find("PRINT_GLYPH_UNSUPPORTED", issue["message"], issue["location"])[0]
            for issue in print_font_issues(ctx.get("book") or {}, ctx.get("edition") or {})]


def check_print_wrap(ctx):
    edition = ctx.get("edition") or {}
    if edition.get("kind") != "print":
        return []
    wrap = edition.get("wrap_cover") or {}
    channel = ctx.get("channel")
    if not wrap.get("enabled"):
        return _find("PRINT_WRAP_REQUIRED", "Enable a full paperback cover (back, spine and front) before creating a retailer package", "edition.wrap_cover") if channel in {"kdp", "barnesnoble", "lulu"} else []
    if wrap.get("profile", "kdp-white") != "custom" and channel not in {None, "export", "kdp"}:
        return _find("PRINT_WRAP_PROFILE", "Use this printer's cover template and custom spine width; KDP paper settings cannot be reused for another printer", "edition.wrap_cover.profile")
    interior = ctx.get("package_bytes")
    if interior:
        cover = ctx.get("cover_pdf_bytes")
        if not cover:
            return _find("PRINT_WRAP_MISSING", "The rendered full paperback cover PDF is missing", "cover.pdf")
        try:
            validate_wrap_pdf(cover, interior, PrintEdition.model_validate(edition))
        except ValueError as error:
            return _find("PRINT_WRAP_INVALID", str(error), "cover.pdf")
    return []


def check_rtl_typography(ctx):
    """Reject output paths known to lack the font and shaping support they need."""
    edition = ctx.get("edition") or {}
    metadata = _meta(ctx)
    language = metadata.get("language")
    direction = resolve_text_direction(language, edition.get("text_direction", "auto"))
    requires_rtl = language_requires_rtl_shaping(language) or direction == "rtl"
    if not requires_rtl:
        return []
    out = []
    if edition.get("kind") == "print":
        out += _find("RTL_PRINT_FONT_UNSUPPORTED",
                     "RTL print PDF requires an embedded shaping-capable font; base PDF fonts are not safe for this script",
                     "edition.text_direction")
    cover = edition.get("cover") or {}
    selected_text = cover.get("asset_id") and (
        (cover.get("title_on_cover", True) and metadata.get("title"))
        or (cover.get("subtitle_on_cover", True) and metadata.get("subtitle"))
        or (cover.get("author_on_cover", True) and metadata.get("author"))
    )
    if selected_text:
        out += _find("RTL_COVER_FONT_UNSUPPORTED",
                     "RTL cover text requires an embedded shaping-capable font; the base cover font is not safe for this script",
                     "edition.cover")
    return out


# ---- accessibility ------------------------------------------------------------

def check_alt_text(ctx):
    out = []
    alt_by_id = {a["id"]: a.get("altText") for a in ctx["book"].get("assets", [])}
    for ch in ctx["book"].get("chapters", []):
        for n in ch.get("nodes", []):
            if n.get("type") == "image":
                if (n.get("attributes") or {}).get("decorative") is True:
                    continue
                alt = n.get("altText") or alt_by_id.get(n.get("assetId"))
                if not alt:
                    out += _find("NO_ALT_TEXT", "image lacks alt text",
                                 f"chapter:{ch['id']} node:{n['id']}")
    return out


# ---- links ---------------------------------------------------------------------

def check_links(ctx):
    out = []
    for ch in ctx["book"].get("chapters", []):
        for n in ch.get("nodes", []):
            for link in n.get("links", []) or []:
                href = link.get("href", "")
                if not href or " " in href:
                    out += _find("BAD_LINK", f"malformed link {href!r}",
                                 f"chapter:{ch['id']} node:{n['id']}")
    return out


# ---- language --------------------------------------------------------------------

def check_language(ctx):
    lang = _meta(ctx).get("language", "")
    if not _LANG_RE.match(lang):
        return _find("BAD_LANGUAGE", f"language tag {lang!r} is not a valid BCP-47-ish tag",
                     "book.metadata.language")
    return []


RULESET = RuleSet(name="core", version=VERSION, rules=[
    Rule("CORE-PKG-001", "error", "package_integrity", "book model shape", check_book_model),
    Rule("CORE-PKG-002", "error", "package_integrity", "artifact zip readable", check_zip_readable),
    Rule("CORE-EPUB-001", "error", "epub_structure", "mimetype first/stored", check_mimetype_first),
    Rule("CORE-EPUB-002", "error", "epub_structure", "container + OPF present", check_container),
    Rule("CORE-NAV-001", "error", "navigation", "nav document + toc", check_nav),
    Rule("CORE-NAV-002", "error", "navigation", "chapter titles", check_chapter_titles),
    Rule("CORE-META-001", "error", "metadata", "required metadata", check_required_metadata),
    Rule("CORE-IMG-001", "error", "images", "image size policy", check_image_sizes),
    Rule("CORE-IMG-002", "error", "images", "image asset references", check_image_refs),
    Rule("CORE-FONT-001", "warning", "fonts", "non-builtin fonts flagged", check_fonts_embedded),
    Rule("CORE-FONT-002", "error", "fonts", "RTL print and cover typography support", check_rtl_typography),
    Rule("CORE-FONT-003", "error", "fonts", "print font glyph coverage", check_print_glyphs),
    Rule("CORE-COVER-001", "error", "channel", "full paperback cover geometry", check_print_wrap),
    Rule("CORE-A11Y-001", "error", "accessibility", "image alt text", check_alt_text),
    Rule("CORE-LINK-001", "error", "links", "link well-formedness", check_links),
    Rule("CORE-LANG-001", "error", "language", "valid language tag", check_language),
])
