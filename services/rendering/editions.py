"""Edition configs (spec section 13): ebook (flow/nav/cover/metadata/image policy) + print
(trim size, bleed, margins, typography, page numbering). Discriminated by `kind`."""
from typing import Literal

from pydantic import BaseModel, Field, field_validator

EDITION_SCHEMA_VERSION = "1.0.0"

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
    allowed_formats: list[str] = ["jpeg", "png", "gif"]


class CoverConfig(BaseModel):
    asset_id: str | None = None
    title_on_cover: bool = False


class EbookEdition(BaseModel):
    kind: Literal["ebook"] = "ebook"
    schema_version: str = EDITION_SCHEMA_VERSION
    flow: Literal["reflowable", "fixed"] = "reflowable"
    navigation: Literal["toc", "toc+landmarks", "none"] = "toc"
    cover: CoverConfig = CoverConfig()
    metadata_overrides: dict[str, str] = {}
    image_policy: ImagePolicy = ImagePolicy()


class Margins(BaseModel):  # inches
    top: float = Field(default=0.75, ge=0)
    bottom: float = Field(default=0.75, ge=0)
    inner: float = Field(default=0.75, ge=0)
    outer: float = Field(default=0.5, ge=0)


class Typography(BaseModel):
    body_font: str = "Times-Roman"  # reportlab builtin = deterministic, no font file
    body_size_pt: float = Field(default=11.0, gt=0)
    heading_font: str = "Helvetica-Bold"
    heading_size_pt: float = Field(default=16.0, gt=0)
    leading: float = Field(default=14.0, gt=0)


class PageNumbering(BaseModel):
    style: Literal["arabic", "roman", "none"] = "arabic"
    start_at: int = Field(default=1, ge=0)
    position: Literal["bottom-center", "bottom-outer", "top-center"] = "bottom-center"


class PrintEdition(BaseModel):
    kind: Literal["print"] = "print"
    schema_version: str = EDITION_SCHEMA_VERSION
    trim_size: str = "6x9"
    bleed_in: float = Field(default=0.0, ge=0, le=0.25)
    margins: Margins = Margins()
    typography: Typography = Typography()
    page_numbering: PageNumbering = PageNumbering()

    @field_validator("trim_size")
    @classmethod
    def _known_trim(cls, v: str) -> str:
        if v not in TRIM_SIZES:
            raise ValueError(f"unknown trim size {v!r}; known: {sorted(TRIM_SIZES)}")
        return v

    @property
    def trim_in(self) -> tuple[float, float]:
        return TRIM_SIZES[self.trim_size]


def parse_edition(data: dict) -> EbookEdition | PrintEdition:
    """Parse untyped edition config dict into the right model."""
    kind = data.get("kind")
    if kind == "print":
        return PrintEdition.model_validate(data)
    if kind == "ebook":
        return EbookEdition.model_validate(data)
    raise ValueError(f"edition kind must be 'ebook' or 'print', got {kind!r}")
