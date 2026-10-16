"""Routing defaults for the standalone-image engine.

``parser_rules=""`` is passed explicitly so these assertions are independent of
any ambient ``LIGHTRAG_PARSER`` in the dev environment.
"""

from __future__ import annotations

import pytest

from lightrag.parser import registry
from lightrag.parser.routing import (
    FilenameParserHintError,
    resolve_file_parser_directives,
)

pytestmark = pytest.mark.offline

_ALL_ENDPOINT_VARS = ("MINERU_LOCAL_ENDPOINT", "MINERU_API_TOKEN", "DOCLING_ENDPOINT")


def _directives(path: str, rules: str = "") -> tuple[str, str]:
    return resolve_file_parser_directives(path, parser_rules=rules)


def test_image_suffixes_in_upload_allowlist_without_external_endpoints(monkeypatch):
    # The allowlist must admit raster images in a default deployment: nothing
    # external gates the image engine. The env cleanup guards against a dev
    # shell exporting endpoints (mineru/docling also claim these suffixes).
    for var in _ALL_ENDPOINT_VARS:
        monkeypatch.delenv(var, raising=False)
    suffixes = registry.available_engine_suffixes()
    for suffix in ("png", "jpg", "jpeg", "webp", "gif"):
        assert suffix in suffixes


def test_bare_image_routes_to_image_engine_with_i():
    for name in ("photo.png", "photo.jpg", "photo.jpeg", "photo.webp", "photo.gif"):
        assert _directives(name) == ("image", "i")


def test_bmp_has_no_image_engine_default():
    # bmp is outside the VLM raster set; with no rule it falls to legacy.
    assert _directives("scan.bmp") == ("legacy", "")


def test_rules_that_cannot_handle_images_fall_through_to_default():
    # env.example's shipped preset: neither native nor legacy claims an image
    # suffix, so the per-suffix default still applies.
    assert _directives("photo.png", rules="*:native-teP,*:legacy-R") == ("image", "i")


def test_rule_options_win_over_default_options():
    # Explicit directives never absorb the "i" default.
    assert _directives("photo.png", rules="png:image-F") == ("image", "F")


def test_rule_selecting_image_engine_explicitly():
    assert _directives("photo.png", rules="png:image") == ("image", "i")


def test_rule_for_unusable_external_engine_falls_through_to_default(monkeypatch):
    # A rule whose engine cannot be used is skipped like any other, and the
    # per-suffix default still applies.
    for var in _ALL_ENDPOINT_VARS:
        monkeypatch.delenv(var, raising=False)
    assert _directives("photo.png", rules="png:mineru") == ("image", "i")
    # native does not declare png either — same fall-through.
    assert _directives("photo.png", rules="png:native") == ("image", "i")


def test_hint_selects_image_engine_explicitly():
    assert _directives("photo.[image].png") == ("image", "i")
    assert _directives("photo.[image-R].png") == ("image", "R")


def test_hint_for_wrong_suffix_engine_is_rejected():
    with pytest.raises(FilenameParserHintError, match="unsupported suffix"):
        _directives("photo.[native].png")


def test_hint_for_external_engine_without_endpoint_is_rejected(monkeypatch):
    for var in _ALL_ENDPOINT_VARS:
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(FilenameParserHintError, match="MINERU_LOCAL_ENDPOINT"):
        _directives("photo.[mineru].png")


def test_hint_to_configured_external_engine_wins(monkeypatch):
    # The hint engine wins; the options half still defaults to "i" because
    # neither hint nor rule supplied options.
    monkeypatch.setenv("MINERU_API_MODE", "local")
    monkeypatch.setenv("MINERU_LOCAL_ENDPOINT", "http://mineru.test:8000")
    assert _directives("photo.[mineru].png") == ("mineru", "i")
