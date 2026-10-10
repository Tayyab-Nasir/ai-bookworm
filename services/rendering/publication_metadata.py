"""Effective edition metadata shared by EPUB, preflight and export metadata."""
import re
from datetime import date


def publication_date(value: object) -> str | None:
    """Preserve the exact saved date; null is not an invented publication date."""
    if value is None:
        return None
    message = "publicationDate must be a valid YYYY-MM-DD calendar date."
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise ValueError(message)
    try:
        date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(message) from error
    return value


def effective_publication_metadata(metadata: dict, overrides: dict | None = None) -> dict:
    """Edition overrides win without mutating saved metadata or inventing dates."""
    if not isinstance(metadata, dict):
        raise ValueError("publishing metadata must be an object")
    if overrides is not None and not isinstance(overrides, dict):
        raise ValueError("edition metadata overrides must be an object")
    effective = {**metadata, **(overrides or {})}
    saved_date = publication_date(effective.get("publicationDate"))
    if saved_date is None:
        # Legacy unset dates do not add a new field to model/export identity.
        effective.pop("publicationDate", None)
    else:
        effective["publicationDate"] = saved_date
    return effective
