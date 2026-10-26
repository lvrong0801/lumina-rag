"""Regression tests for document-version labels on the query path.

``_annotate_chunks_with_doc_version`` stamps each retrieved chunk with
``doc_version`` resolved from doc_status ``metadata.version`` (chunks carry
no document metadata of their own); the renderer then emits the tag inside
the LLM context, and the query paths append the ``---Document Versions---``
conflict-resolution rule to the system prompt only when the retrieved chunks
span 2+ distinct versions — a single-version context gains nothing from it.
"""

import pytest

from lightrag.base import QueryParam
from lightrag.operate import _annotate_chunks_with_doc_version, naive_query
from lightrag.prompt import PROMPTS
from lightrag.utils import Tokenizer, render_chunks_context_text


class _FakeDocStatus:
    def __init__(self, versions_by_basename, *, raises=False):
        self._map = versions_by_basename
        self._raises = raises
        self.calls = []

    async def get_doc_by_file_basename(self, basename):
        self.calls.append(basename)
        if self._raises:
            raise RuntimeError("store down")
        version = self._map.get(basename)
        if version is None:
            return None
        return {"metadata": {"version": version}}


@pytest.mark.offline
@pytest.mark.asyncio
async def test_annotation_labels_chunks_and_collects_distinct_versions():
    doc_status = _FakeDocStatus({"a.md": "2.0", "b.md": "1.0"})
    chunks = [
        {"file_path": "inputs/a.md", "content": "A1"},
        {"file_path": "a.md", "content": "A2"},  # same doc again
        {"file_path": "b.md", "content": "B"},
        {"file_path": "unknown_source", "content": "U"},
        {"file_path": "ghost.md", "content": "G"},  # doc row missing
    ]
    versions = await _annotate_chunks_with_doc_version(chunks, doc_status)
    assert versions == {"1.0", "2.0"}
    assert chunks[0]["doc_version"] == "2.0"
    assert chunks[1]["doc_version"] == "2.0"
    assert chunks[2]["doc_version"] == "1.0"
    assert "doc_version" not in chunks[3]
    assert "doc_version" not in chunks[4]
    # Basename-keyed per-query cache: the repeat file costs no extra lookup.
    assert doc_status.calls == ["a.md", "b.md", "ghost.md"]


@pytest.mark.offline
@pytest.mark.asyncio
async def test_annotation_fails_open_when_the_store_errors():
    chunks = [{"file_path": "a.md", "content": "A"}]
    versions = await _annotate_chunks_with_doc_version(
        chunks, _FakeDocStatus({}, raises=True)
    )
    assert versions == set()
    assert "doc_version" not in chunks[0]


@pytest.mark.offline
async def test_render_emits_doc_version_only_when_present():
    rendered = render_chunks_context_text(
        [
            {"reference_id": "1", "doc_version": "2.0", "content": "A"},
            {"reference_id": "2", "content": "B"},
        ]
    )
    line_tagged, line_plain = rendered.split("\n")
    assert '"doc_version": "2.0"' in line_tagged
    assert line_tagged.index("doc_version") < line_tagged.index("content")
    assert "doc_version" not in line_plain


class _FakeTokenizerImpl:
    def encode(self, content: str) -> list[int]:
        return [ord(ch) for ch in content]

    def decode(self, tokens: list[int]) -> str:
        return "".join(chr(token) for token in tokens)


def _fake_tokenizer() -> Tokenizer:
    return Tokenizer("fake", _FakeTokenizerImpl())


class _FakeChunksVDB:
    cosine_better_than_threshold = 0.0

    def __init__(self, chunks):
        self._chunks = chunks

    async def query(self, *_args, **_kwargs):
        return list(self._chunks)


def _query_global_config(captured: dict) -> dict:
    async def query_model(*_args, **kwargs):
        captured["system_prompt"] = kwargs.get("system_prompt", "")
        return "answer"

    return {
        "tokenizer": _fake_tokenizer(),
        "role_llm_funcs": {"query": query_model},
        "min_rerank_score": 0.0,
        "max_total_tokens": 4096,
    }


async def _naive_system_prompt(versions_by_basename, chunk_files=None):
    chunk_files = chunk_files or list(versions_by_basename)
    chunks_vdb = _FakeChunksVDB(
        [
            {
                "id": f"chunk-{name}",
                "content": f"content of {name}",
                "file_path": name,
            }
            for name in chunk_files
        ]
    )
    captured: dict = {}
    result = await naive_query(
        "which rule wins?",
        chunks_vdb,
        QueryParam(mode="naive", enable_rerank=False),
        _query_global_config(captured),
        doc_status=_FakeDocStatus(versions_by_basename),
    )
    assert result is not None
    return captured["system_prompt"], result


@pytest.mark.offline
@pytest.mark.asyncio
async def test_naive_query_appends_conflict_rule_only_across_versions():
    sys_prompt, result = await _naive_system_prompt({"a.md": "2.0", "b.md": "1.0"})
    assert PROMPTS["version_conflict_hint"] in sys_prompt
    assert (result.raw_data.get("metadata") or {}).get("doc_versions") == [
        "1.0",
        "2.0",
    ]

    sys_prompt, result = await _naive_system_prompt({"a.md": "2.0", "b.md": "2.0"})
    assert "Document Versions" not in sys_prompt
    assert (result.raw_data.get("metadata") or {}).get("doc_versions") == ["2.0"]

    # Doc rows without a version (unmigrated corpus): no labels, no rule.
    sys_prompt, result = await _naive_system_prompt({}, chunk_files=["a.md"])
    assert "Document Versions" not in sys_prompt
    assert (result.raw_data.get("metadata") or {}).get("doc_versions") == []
