"""End-to-end parse for the standalone-image engine.

Drives the production registry path (``get_parser("image").parse(ParseContext)``)
against the debug LightRAG stand-in and asserts the produced sidecar is the
same shape an embedded image gets from a document parser: one drawing block,
one drawings.json item, and the source copied into the assets directory.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
from pathlib import Path

import pytest

from lightrag.constants import (
    FULL_DOCS_FORMAT_LIGHTRAG,
    FULL_DOCS_FORMAT_PENDING_PARSE,
    PARSED_DIR_NAME,
)
from lightrag.parser.base import ParseContext
from lightrag.parser.debug import build_debug_rag
from lightrag.parser.registry import get_parser

pytestmark = pytest.mark.offline

# 1x1 transparent PNG.
_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhf"
    "DwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def _parse(tmp_path: Path, name: str = "photo.png", data: bytes = _PNG_BYTES):
    source = tmp_path / name
    source.write_bytes(data)
    rag = build_debug_rag()
    parser = get_parser("image")
    assert parser is not None, "image engine not registered"
    ctx = ParseContext(
        rag=rag,
        doc_id="doc-" + "a" * 32,
        file_path=str(source),
        content_data={
            "parse_engine": "image",
            "parse_format": FULL_DOCS_FORMAT_PENDING_PARSE,
            "content": "",
        },
    )
    result = asyncio.run(parser.parse(ctx))
    return rag, ctx, source, result


def test_parse_produces_one_drawing_sidecar(tmp_path):
    rag, ctx, source, result = _parse(tmp_path)

    assert result.parse_format == FULL_DOCS_FORMAT_LIGHTRAG
    assert result.parse_engine == "image"

    parsed_dir = tmp_path / PARSED_DIR_NAME / "photo.png.parsed"
    blocks_path = parsed_dir / "photo.blocks.jsonl"
    assert Path(result.blocks_path) == blocks_path

    lines = blocks_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2  # meta + the single drawing block
    meta = json.loads(lines[0])
    assert meta["parse_engine"] == "image"

    row = json.loads(lines[1])
    assert row["heading"] == "photo"
    tag = row["content"]
    assert tag.startswith("<drawing ")
    assert 'format="png"' in tag
    assert 'path="photo.blocks.assets/photo.png"' in tag
    drawing_id = re.search(r'id="([^"]+)"', tag).group(1)

    drawings = json.loads((parsed_dir / "photo.drawings.json").read_text(encoding="utf-8"))[
        "drawings"
    ]
    assert list(drawings) == [drawing_id]
    drawing = drawings[drawing_id]
    assert drawing["format"] == "png"
    assert drawing["path"] == "photo.blocks.assets/photo.png"

    # No table / equation content, so no such sidecar is written.
    assert not (parsed_dir / "photo.tables.json").exists()
    assert not (parsed_dir / "photo.equations.json").exists()

    # The asset is a byte-for-byte copy of the original upload.
    asset = parsed_dir / "photo.blocks.assets" / "photo.png"
    assert asset.read_bytes() == _PNG_BYTES

    # The source is archived into __parsed__ after the full_docs sync.
    assert not source.exists()
    assert (tmp_path / PARSED_DIR_NAME / "photo.png").read_bytes() == _PNG_BYTES

    persisted = rag.full_docs.data[ctx.doc_id]
    assert persisted["parse_engine"] == "image"
    assert persisted["parse_format"] == FULL_DOCS_FORMAT_LIGHTRAG


def test_parse_rejects_undecodable_image_header(tmp_path):
    with pytest.raises(ValueError, match="cannot decode image header"):
        _parse(tmp_path, data=b"definitely not an image")
    # The refusal happens before the parsed dir is created, leaving no residue.
    assert not (tmp_path / PARSED_DIR_NAME).exists()


def test_parse_rejects_non_image_suffix(tmp_path):
    with pytest.raises(ValueError, match="does not support"):
        _parse(tmp_path, name="photo.bmp")
