"""PyMuPDF4LLM engine adapter: in-process PDF -> markdown extraction.

Availability is gated in the registry on the optional ``pymupdf4llm``
package, so this module is imported lazily (``get_parser``) only on the
first document actually routed here.
"""

from __future__ import annotations

import asyncio
import time

from lightrag.constants import FULL_DOCS_FORMAT_RAW, PARSER_ENGINE_PYMUPDF4LLM
from lightrag.parser.base import BaseParser, ParseContext, ParseResult


class PyMuPDF4LLMExtractionError(RuntimeError):
    """Raised when pymupdf4llm cannot produce usable markdown."""


class PyMuPDF4LLMParser(BaseParser):
    """Extract a PDF to markdown in-process and store it as a ``raw`` doc.

    The markdown (headings, tables, reading order preserved) lands in
    ``full_docs["content"]`` like the legacy plain-text extractors, so the
    downstream chunking path is unchanged — only the text quality differs.
    """

    engine_name = PARSER_ENGINE_PYMUPDF4LLM

    async def parse(self, ctx: ParseContext) -> ParseResult:
        import pymupdf4llm

        rs = ctx.resolve(self.engine_name)
        source = rs.source_path
        if not source.is_file():
            raise FileNotFoundError(
                f"pymupdf4llm source file not found: {source}"
            )

        def _extract() -> str:
            # to_markdown accepts a path or a fitz Document; passing the path
            # keeps password-free PDFs on the library's own fast path.
            return pymupdf4llm.to_markdown(str(source))

        try:
            text = await asyncio.to_thread(_extract)
        except Exception as exc:
            raise PyMuPDF4LLMExtractionError(
                f"pymupdf4llm failed on {ctx.file_path} (doc_id={ctx.doc_id}): "
                f"{exc}"
            ) from exc

        # A scanned PDF with no text layer extracts to whitespace; fail the
        # parse instead of persisting an empty document into chunking (same
        # policy as the legacy extractors).
        if not text.strip():
            raise PyMuPDF4LLMExtractionError(
                f"pymupdf4llm extracted no usable text from {ctx.file_path} "
                f"(doc_id={ctx.doc_id})"
            )

        await ctx.rag._persist_parsed_full_docs(
            ctx.doc_id,
            {
                "content": text,
                "file_path": ctx.file_path,
                "parse_format": FULL_DOCS_FORMAT_RAW,
                "parse_engine": self.engine_name,
                "update_time": int(time.time()),
            },
        )
        await ctx.archive_source(str(source))
        return ParseResult(
            doc_id=ctx.doc_id,
            file_path=ctx.file_path,
            parse_format=FULL_DOCS_FORMAT_RAW,
            content=text,
            blocks_path="",
            parse_engine=self.engine_name,
        )
