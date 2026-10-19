"""Tests for per-document upload-intent overrides (doc status metadata).

``/documents/upload`` may pin ``summary_language`` / ``enable_multimodal``
for a single document.  The values:

* are written into ``doc_status.metadata`` at enqueue (via doc_status_extra);
* must survive every stage transition (carry-over whitelist) AND a
  FAILED->PENDING reset (directive whitelist) — otherwise a retry would
  silently process the document under the server defaults the upload
  explicitly overrode;
* map onto the ``global_config`` slots ``_resolved_summary_language`` /
  ``vlm_process_enable`` via ``doc_processing_overrides``, so consumers can
  patch a fresh ``_build_global_config()`` copy with a plain ``update``.
"""

from types import SimpleNamespace

import pytest

from lightrag.utils_pipeline import (
    _DOC_STATUS_METADATA_CARRY_OVER_KEYS,
    _DOC_STATUS_METADATA_DIRECTIVE_KEYS,
    ENABLE_MULTIMODAL_METADATA_KEY,
    SUMMARY_LANGUAGE_METADATA_KEY,
    doc_processing_overrides,
)

pytestmark = pytest.mark.offline


def test_overrides_map_metadata_onto_global_config_keys():
    status_doc = SimpleNamespace(
        metadata={"summary_language": "English", "enable_multimodal": True}
    )
    assert doc_processing_overrides(status_doc) == {
        "_resolved_summary_language": "English",
        "vlm_process_enable": True,
    }


def test_overrides_support_toggling_multimodal_off():
    """False is a real override, not an absent value — a document the upload
    marked text-only must stay text-only on retry too."""
    status_doc = SimpleNamespace(metadata={"enable_multimodal": False})
    assert doc_processing_overrides(status_doc) == {"vlm_process_enable": False}


def test_overrides_absent_and_malformed_values_ignored():
    assert doc_processing_overrides(SimpleNamespace(metadata={})) == {}
    assert doc_processing_overrides(SimpleNamespace(metadata=None)) == {}
    assert doc_processing_overrides(None) == {}
    # Blank language and non-bool multimodal values (e.g. written by another
    # version) fall back to the server defaults instead of poisoning the run.
    status_doc = SimpleNamespace(
        metadata={"summary_language": "   ", "enable_multimodal": "yes"}
    )
    assert doc_processing_overrides(status_doc) == {}
    stripped = SimpleNamespace(metadata={"summary_language": "  Chinese "})
    assert doc_processing_overrides(stripped) == {
        "_resolved_summary_language": "Chinese"
    }


def test_upload_intent_keys_survive_transitions_and_reset():
    for key in (SUMMARY_LANGUAGE_METADATA_KEY, ENABLE_MULTIMODAL_METADATA_KEY):
        assert key in _DOC_STATUS_METADATA_CARRY_OVER_KEYS, (
            f"{key} dropped from carry-over: a stage transition would lose "
            "the upload-intent override and re-chunk under server defaults"
        )
        assert key in _DOC_STATUS_METADATA_DIRECTIVE_KEYS, (
            f"{key} dropped from directives: a FAILED->PENDING retry would "
            "process the document under server defaults despite the upload's "
            "explicit override"
        )
