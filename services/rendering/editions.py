"""Edition configs (spec section 13): ebook (flow/nav/cover/metadata/image policy) + print
(trim size, bleed, margins, typography, page numbering). Discriminated by `kind`."""
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator, model_validator

EDITION_SCHEMA_VERSION = "1.1.0"

# EPUB readers can apply bidirectional layout and select a suitable local font
# from the document language. The deterministic print and raster-cover renderers
# intentionally do not pretend to shape these scripts with their Latin base fonts.
_RTL_LANGUAGES = frozenset({"ar", "arc", "dv", "fa", "he", "iw", "nqo", "ps", "sd", "ug", "ur", "yi"})
_RTL_SCRIPTS = frozenset({"arab", "hebr", "nkoo", "thaa"})


def language_requires_rtl_shaping(language: object) -> bool:
    """Return whether a BCP-47-ish tag selects a script needing RTL shaping."""
    if not isinstance(language, str):
        return False
    parts = [part.casefold() for part in language.replace("_", "-").split("-") if part]
    return bool(parts) and (parts[0] in _RTL_LANGUAGES or any(part in _RTL_SCRIPTS for part in parts[1:]))


def resolve_text_direction(language: object, preference: object = "auto") -> Literal["ltr", "rtl"]:
    """Resolve an explicit edition preference, then infer a safe default from language."""
    if preference == "rtl":
        return "rtl"
    if preference == "ltr":
        return "ltr"
    return "rtl" if language_requires_rtl_shaping(language) else "ltr"

# trim size presets, inches
TRIM_SIZES: dict[str, tuple[float, float]] = {
    "5x8": (5.0, 8.0),
    "5.5x8.5": (5.5, 8.5),
    "6x9": (6.0, 9.0),
    "7x10": (7.0, 10.0),
    "8.5x11": (8.5, 11.0),
}


class ImagePolicy(BaseModel):
    max_width_px: int = Field(default=1600, gt=0)
    max_bytes: int = Field(default=5 * 1024 * 1024, gt=0)
    embed: bool = True  # inline images vs strip with placeholder
    allowed_formats: list[str] = Field(default_factory=lambda: ["jpeg", "png", "gif"])


class QrCodeConfig(BaseModel):
    enabled: bool = False
    url: str | None = None
    label: str | None = Field(default=None, max_length=120)
    position: Literal["bottom-left", "bottom-right"] = "bottom-right"
    size_px: int = Field(default=180, ge=96, le=512)

    @model_validator(mode="after")
    def _valid_destination(self):
        destination = urlsplit(self.url or "")
        if self.enabled and (destination.scheme.lower() != "https" or not destination.netloc):
            raise ValueError("enabled QR code requires an HTTPS URL")
        return self


class CoverConfig(BaseModel):
    asset_id: str | None = None
    title_on_cover: bool = True
    subtitle_on_cover: bool = True
    author_on_cover: bool = True
    text_color: str = Field(default="#ffffff", pattern=r"^#[0-9a-fA-F]{6}$")
    overlay_opacity: float = Field(default=0.28, ge=0, le=0.9)
    qr_code: QrCodeConfig = Field(default_factory=QrCodeConfig)

    @model_validator(mode="after")
    def _qr_needs_artwork(self):
        if self.qr_code.enabled and not self.asset_id:
            raise ValueError("QR code requires a cover asset")
        return self


class EbookEdition(BaseModel):
    kind: Literal["ebook"] = "ebook"
    schema_version: str = EDITION_SCHEMA_VERSION
    text_direction: Literal["auto", "ltr", "rtl"] = "auto"
    flow: Literal["reflowable", "fixed"] = "reflowable"
    navigation: Literal["toc", "toc+landmarks", "none"] = "toc"
    cover: CoverConfig = Field(default_factory=CoverConfig)
    metadata_overrides: dict[str, str] = Field(default_factory=dict)
    image_policy: ImagePolicy = Field(default_factory=ImagePolicy)


class Margins(BaseModel):  # inches
    top: float = Field(default=0.75, ge=0)
    bottom: float = Field(default=0.75, ge=0)
    inner: float = Field(default=0.75, ge=0)
    outer: float = Field(default=0.5, ge=0)


class Typography(BaseModel):
    body_font: Literal["Times-Roman", "Times-Bold", "Helvetica", "Helvetica-Bold", "Courier", "Courier-Bold", "BookwormVera", "BookwormVera-Bold"] = "Times-Roman"
    body_size_pt: float = Field(default=11.0, gt=0)
    heading_font: Literal["Times-Roman", "Times-Bold", "Helvetica", "Helvetica-Bold", "Courier", "Courier-Bold", "BookwormVera", "BookwormVera-Bold"] = "Helvetica-Bold"
    heading_size_pt: float = Field(default=16.0, gt=0)
    leading: float = Field(default=14.0, gt=0)
    paragraph_spacing_pt: float = Field(default=6.0, ge=0, le=36)
    first_line_indent_in: float = Field(default=0.25, ge=0, le=1)
    text_align: Literal["left", "justify"] = "justify"

    @model_validator(mode="after")
    def _leading_fits_text(self):
        if self.leading < self.body_size_pt:
            raise ValueError("leading must be at least the body font size")
        return self


class PageNumbering(BaseModel):
    style: Literal["arabic", "roman", "none"] = "arabic"
    start_at: int = Field(default=1, ge=0)
    position: Literal["bottom-center", "bottom-outer", "top-center"] = "bottom-center"


class WrapCover(BaseModel):
    enabled: bool = False
    profile: Literal["kdp-white", "kdp-cream", "kdp-standard-color", "kdp-premium-color", "custom"] = "kdp-white"
    spine_width_in: float = Field(default=0.25, ge=0.01, le=3)
    expected_page_count: int | None = Field(default=None, ge=1, le=2000)
    back_text: str = Field(default="", max_length=3000)
    spine_text: str = Field(default="", max_length=200)
    background_color: str = Field(default="#182528", pattern=r"^#[0-9a-fA-F]{6}$")
    text_color: str = Field(default="#ffffff", pattern=r"^#[0-9a-fA-F]{6}$")


class PrintEdition(BaseModel):
    kind: Literal["print"] = "print"
    schema_version: str = EDITION_SCHEMA_VERSION
    text_direction: Literal["auto", "ltr", "rtl"] = "auto"
    trim_size: str = "6x9"
    bleed_in: float = Field(default=0.0, ge=0, le=0.25)
    bleed_edges: Literal["all", "outer"] = "all"
    margins: Margins = Field(default_factory=Margins)
    typography: Typography = Field(default_factory=Typography)
    page_numbering: PageNumbering = Field(default_factory=PageNumbering)
    cover: CoverConfig = Field(default_factory=CoverConfig)
    wrap_cover: WrapCover = Field(default_factory=WrapCover)

    @model_validator(mode="after")
    def _wrap_source(self):
        if self.wrap_cover.enabled:
            if not self.cover.asset_id:
                raise ValueError("full paperback cover requires front cover artwork")
            if self.wrap_cover.profile == "custom" and not self.wrap_cover.expected_page_count:
                raise ValueError("custom spine width requires the template page count")
        return self

    @field_validator("trim_size")
    @classmethod
    def _known_trim(cls, v: str) -> str:
        if v not in TRIM_SIZES:
            raise ValueError(f"unknown trim size {v!r}; known: {sorted(TRIM_SIZES)}")
        return v

    @property
    def trim_in(self) -> tuple[float, float]:
        return TRIM_SIZES[self.trim_size]


def edition_requires_rtl_typography(edition: EbookEdition | PrintEdition, metadata: dict) -> bool:
    """True when the selected language or explicit direction needs RTL support."""
    language = metadata.get("language")
    return language_requires_rtl_shaping(language) or resolve_text_direction(language, edition.text_direction) == "rtl"


def print_requires_unsupported_rtl_typography(edition: PrintEdition, metadata: dict) -> bool:
    return edition_requires_rtl_typography(edition, metadata)


def cover_requires_unsupported_rtl_typography(edition: EbookEdition | PrintEdition, metadata: dict) -> bool:
    if not edition.cover.asset_id or not edition_requires_rtl_typography(edition, metadata):
        return False
    cover = edition.cover
    return any((enabled and metadata.get(key)) for enabled, key in (
        (cover.title_on_cover, "title"),
        (cover.subtitle_on_cover, "subtitle"),
        (cover.author_on_cover, "author"),
    ))


def parse_edition(data: dict) -> EbookEdition | PrintEdition:
    """Parse untyped edition config dict into the right model."""
    kind = data.get("kind")
    if kind == "print":
        return PrintEdition.model_validate(data)
    if kind == "ebook":
        return EbookEdition.model_validate(data)
    raise ValueError(f"edition kind must be 'ebook' or 'print', got {kind!r}")
