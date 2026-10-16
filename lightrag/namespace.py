from __future__ import annotations

import re
from typing import Iterable


# All namespace should not be changed
class NameSpace:
    KV_STORE_FULL_DOCS = "full_docs"
    KV_STORE_TEXT_CHUNKS = "text_chunks"
    KV_STORE_LLM_RESPONSE_CACHE = "llm_response_cache"
    KV_STORE_FULL_ENTITIES = "full_entities"
    KV_STORE_FULL_RELATIONS = "full_relations"
    KV_STORE_ENTITY_CHUNKS = "entity_chunks"
    KV_STORE_RELATION_CHUNKS = "relation_chunks"

    VECTOR_STORE_ENTITIES = "entities"
    VECTOR_STORE_RELATIONSHIPS = "relationships"
    VECTOR_STORE_CHUNKS = "chunks"

    GRAPH_STORE_CHUNK_ENTITY_RELATION = "chunk_entity_relation"

    DOC_STATUS = "doc_status"


def is_namespace(namespace: str, base_namespace: str | Iterable[str]):
    if isinstance(base_namespace, str):
        return namespace.endswith(base_namespace)
    return any(is_namespace(namespace, ns) for ns in base_namespace)


def sanitize_workspace_component(name: str) -> str:
    """Normalize a workspace name into a backend-safe namespace component.

    Milvus collection names must match ``^[a-zA-Z_][a-zA-Z0-9_]*$``. Several
    other backends restrict characters to a similar ``[a-zA-Z0-9_-]`` or
    alphanumeric-only set. A workspace name like ``"token-factory"`` or
    ``"tenant 3"`` therefore fails at creation time (typically surfaced by
    Milvus as ``(code=1100, message=Invalid collection name: ...)``).

    The sanitizer collapses every run of characters outside ``[a-zA-Z0-9_]``
    to a single underscore (so ``"token-factory"`` becomes ``"token_factory"``
    and ``"tenant 3"`` becomes ``"tenant_3"``), and prefixes a leading digit
    with an underscore so Milvus still accepts it. A name that was already
    valid is returned unchanged, so existing storage namespaces keep finding
    their rows without a migration.
    """
    sanitized = re.sub(r"[^a-zA-Z0-9_]+", "_", name)
    if sanitized and sanitized[0].isdigit():
        sanitized = f"_{sanitized}"
    return sanitized
