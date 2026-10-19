"""Unit tests for the pymupdf4llm engine (lightrag.parser.pymupdf4llm).

Covers the registry gate (package-availability closure) and the parse
contract: success path (persist + archive + RAW ParseResult), the
whitespace-only extraction guard (scanned PDF), and library-failure
wrapping. The optional package is faked via ``sys.modules`` so the tests
pass with or without ``pymupdf4llm`` installed.
"""

import sys
import types

import pytest

import lightrag.pipeline as _pipeline
from lightrag.constants import FULL_DOCS_FORMAT_RAW
from lightrag.parser import registry
from lightrag.parser.base import ParseContext
from lightrag.parser.pymupdf4llm.parser import (
    PyMuPDF4LLMExtractionError,
    PyMuPDF4LLMParser,
)

pytestmark = pytest.mark.offline


class _FakeRag:
    def __init__(self):
        self.persisted = []

    async def _persist_parsed_full_docs(self, doc_id, payload):
        self.persisted.append((doc_id, payload))

    def _resolve_source_file_for_parser(
        self, file_path, *, source_file=None, parser_engine=None
    ):
        return file_path


@pytest.fixture
def archived(monkeypatch):
    calls = []

    async def _record(source_path):
        calls.append(source_path)
        return source_path

    monkeypatch.setattr(_pipeline, "archive_docx_source_after_full_docs_sync", _record)
    return calls


@pytest.fixture
def fake_pymupdf4llm(monkeypatch):
    """Fake the optional package; tests stay hermetic either way."""
    module = types.ModuleType("pymupdf4llm")
    module.to_markdown = lambda path: "# 标题\n\n正文 **加粗** 段落。\n"
    monkeypatch.setitem(sys.modules, "pymupdf4llm", module)
    return module


def _ctx(rag, source_path):
    return ParseContext(rag, "doc-pymupdf", str(source_path), {})


# ---------------------------------------------------------------------------
# Registry gate
# ---------------------------------------------------------------------------


def test_registry_spec_shape():
    spec = registry.parser_specs_snapshot()["pymupdf4llm"]
    assert spec.user_selectable
    assert spec.suffixes == frozenset({"pdf"})
    assert spec.queue_group == "native"
    assert spec.impl == "lightrag.parser.pymupdf4llm.parser:PyMuPDF4LLMParser"


def test_registry_gate_follows_package_presence(monkeypatch):
    import importlib.util

    monkeypatch.setattr(
        importlib.util, "find_spec", lambda name: object() if name == "pymupdf4llm" else None
    )
    assert registry.engine_endpoint_configured("pymupdf4llm") is True

    monkeypatch.setattr(importlib.util, "find_spec", lambda name: None)
    assert registry.engine_endpoint_configured("pymupdf4llm") is False
    assert "pymupdf4llm" in registry.engine_endpoint_requirement("pymupdf4llm")


def test_registry_get_parser_loads_lazily():
    parser = registry.get_parser("pymupdf4llm")
    assert isinstance(parser, PyMuPDF4LLMParser)
    assert parser.engine_name == "pymupdf4llm"


# ---------------------------------------------------------------------------
# Parse contract
# ---------------------------------------------------------------------------


async def test_parse_markdown_persists_and_archives(tmp_path, archived, fake_pymupdf4llm):
    source = tmp_path / "report.pdf"
    source.write_bytes(b"%PDF-fake")
    rag = _FakeRag()

    result = await PyMuPDF4LLMParser().parse(_ctx(rag, source))

    assert result.parse_format == FULL_DOCS_FORMAT_RAW
    assert result.content.startswith("# 标题")
    assert result.parse_engine == "pymupdf4llm"
    assert result.blocks_path == ""
    doc_id, payload = rag.persisted[0]
    assert doc_id == "doc-pymupdf"
    assert payload["content"] == result.content
    assert payload["parse_format"] == FULL_DOCS_FORMAT_RAW
    assert payload["parse_engine"] == "pymupdf4llm"
    assert archived == [str(source)]
    assert "parse_stage_skipped" not in result.to_dict()


async def test_parse_passes_source_path_to_library(tmp_path, archived, fake_pymupdf4llm):
    seen = {}
    fake_pymupdf4llm.to_markdown = lambda path: seen.setdefault("path", path) or "正文"
    source = tmp_path / "flow.pdf"
    source.write_bytes(b"%PDF-fake")
    rag = _FakeRag()

    await PyMuPDF4LLMParser().parse(_ctx(rag, source))

    assert seen["path"].endswith("flow.pdf")


async def test_parse_whitespace_only_raises(tmp_path, archived, fake_pymupdf4llm):
    # Scanned PDFs (image-only pages) extract to whitespace; the parser must
    # fail the doc like the legacy extractors instead of ingesting nothing.
    fake_pymupdf4llm.to_markdown = lambda path: "\n \n\t\n"
    source = tmp_path / "scanned.pdf"
    source.write_bytes(b"%PDF-fake")
    rag = _FakeRag()

    with pytest.raises(PyMuPDF4LLMExtractionError, match="no usable text"):
        await PyMuPDF4LLMParser().parse(_ctx(rag, source))

    assert rag.persisted == []
    assert archived == []


async def test_parse_library_failure_is_wrapped(tmp_path, archived, fake_pymupdf4llm):
    def _boom(path):
        raise RuntimeError("damaged xref table")

    fake_pymupdf4llm.to_markdown = _boom
    source = tmp_path / "broken.pdf"
    source.write_bytes(b"%PDF-fake")
    rag = _FakeRag()

    with pytest.raises(PyMuPDF4LLMExtractionError, match="damaged xref table"):
        await PyMuPDF4LLMParser().parse(_ctx(rag, source))

    assert rag.persisted == []


async def test_parse_missing_source_raises(tmp_path, fake_pymupdf4llm):
    rag = _FakeRag()
    with pytest.raises(FileNotFoundError, match="source file not found"):
        await PyMuPDF4LLMParser().parse(_ctx(rag, tmp_path / "absent.pdf"))
