"""KDP paperback page ranges shared by cover rendering and preflight.

Source: https://kdp.amazon.com/en_US/help/topic/G201857950 (2026-09-18).
Ranges cover the five trim sizes currently exposed by PrintEdition.
"""


def kdp_page_count(count: int) -> int:
    """KDP rounds manuscript pages up to an even number before manufacturing."""
    return count + count % 2


def kdp_page_range(profile: str, trim_size: str) -> tuple[int, int]:
    if profile == "kdp-standard-color":
        return 72, 600
    if profile == "kdp-cream":
        return 24, 550 if trim_size == "8.5x11" else 776
    if profile in {"kdp-white", "kdp-premium-color"}:
        return 24, 590 if trim_size == "8.5x11" else 828
    # A custom printer template does not identify ink/paper. This is only the
    # absolute supported range; preflight separately reports missing stock.
    return 24, 600 if trim_size == "8.5x11" else 828
