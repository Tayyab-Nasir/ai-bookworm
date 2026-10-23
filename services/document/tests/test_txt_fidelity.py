"""Preserve Unicode and opening manuscript text at the TXT import boundary."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from parsers import ParseError
from parsers import txt_parser


@pytest.mark.parametrize("text", [
    "# Harbor Import — Synthetic Acceptance\n\nMira found a silver compass.",
    "Café déjà vu.",
    "Mira’s notebook: ‘harbor’ and “lighthouse”.",
    "A quiet harbor 🌊 and a silver compass 🧭.",
    "میرے شہر کی کہانی۔",
    "物語の始まり。",
    "Plain ASCII remains exact.",
])
def test_valid_utf8_never_uses_statistical_encoding_guess(monkeypatch, text):
    def forbidden_guess(_data):
        raise AssertionError("A valid UTF-8 manuscript must not be reinterpreted")

    monkeypatch.setattr(txt_parser.chardet, "detect", forbidden_guess)
    book, report = txt_parser.parse_txt(text.encode("utf-8"), title="Synthetic")
    actual = "\n\n".join(node["text"] for chapter in book["chapters"] for node in chapter["nodes"])
    assert actual == text
    assert report["warnings"] == []


def test_utf8_bom_is_removed_without_changing_characters(monkeypatch):
    monkeypatch.setattr(txt_parser.chardet, "detect", lambda _data: {"encoding": "Windows-1252", "confidence": 1})
    book, report = txt_parser.parse_txt("Mira — the harbor.".encode("utf-8-sig"))
    assert book["chapters"][0]["nodes"][0]["text"] == "Mira — the harbor."
    assert report["warnings"] == []


def test_an_explicit_utf8_bom_with_invalid_bytes_is_rejected_not_guessed():
    with pytest.raises(ParseError, match="UTF-8 manuscript contains invalid text"):
        txt_parser.parse_txt(b"\xef\xbb\xbfMira \xff harbor")


def test_legacy_encoding_is_considered_only_after_strict_utf8_fails(monkeypatch):
    text = "Café déjà vu — a ‘silver’ compass."
    seen = []

    def legacy(data):
        seen.append(data)
        return {"encoding": "Windows-1252", "confidence": 0.73}

    monkeypatch.setattr(txt_parser.chardet, "detect", legacy)
    book, report = txt_parser.parse_txt(text.encode("cp1252"))
    assert seen == [text.encode("cp1252")]
    assert book["chapters"][0]["nodes"][0]["text"] == text
    assert report["warnings"] == ["encoding detection low confidence (Windows-1252, 0.73)"]


@pytest.mark.parametrize("opening", [
    "A dedication before the first chapter.\n\nA second opening paragraph.\n\n",
    "An opening sentence immediately before the heading.\n",
])
def test_opening_prose_survives_a_later_chapter_heading(opening):
    text = opening + "Chapter 1\n\nMira reached the harbor.\n\nChapter 2\n\nThe compass turned.\n"
    book, report = txt_parser.parse_txt(text.encode("utf-8"), title="Opening pages")
    assert [chapter["title"] for chapter in book["chapters"]] == ["Opening pages", "Chapter 1", "Chapter 2"]
    assert [chapter["order"] for chapter in book["chapters"]] == [0, 1, 2]
    assert [node["text"] for node in book["chapters"][0]["nodes"]] == [value.strip() for value in opening.strip().split("\n\n")]
    assert book["chapters"][1]["nodes"][1]["text"] == "Mira reached the harbor."
    assert book["chapters"][2]["nodes"][1]["text"] == "The compass turned."
    assert report["chapterCount"] == 3


def test_heading_first_does_not_create_an_empty_opening_chapter():
    book, _ = txt_parser.parse_txt(b"\n\nChapter 1\n\nMira wrote.\n")
    assert len(book["chapters"]) == 1
    assert book["chapters"][0]["title"] == "Chapter 1"


@pytest.mark.parametrize("data", [b"", b" \n\t\n", b"\xef\xbb\xbf"])
def test_blank_manuscript_remains_rejected(data):
    with pytest.raises(ParseError, match="text file is empty"):
        txt_parser.parse_txt(data)


def test_binary_nul_cannot_hide_after_the_first_four_kibibytes():
    with pytest.raises(ParseError, match="file looks binary"):
        txt_parser.parse_txt(b"An apparently ordinary line.\n" * 200 + b"\x00hidden tail")
