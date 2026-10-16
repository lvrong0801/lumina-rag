"""Native standalone-image engine (.png/.jpg/.jpeg/.webp/.gif).

Turns an uploaded raster image into the same sidecar a document parser
produces for an EMBEDDED image: one drawing block whose asset is a copy of
the source file. Everything downstream — VLM analysis under the ``i``
process option (defaulted on for these suffixes, see
``routing._DEFAULT_DIRECTIVES_BY_SUFFIX``), multimodal chunk building,
purge — is the shared pipeline, unchanged; this engine exists because an
image file has no document structure to parse.

The VLM analysis is not optional decoration: the ``<drawing/>`` tag in
blocks.jsonl contributes no extractable text, so the VLM description is
the document's ONLY searchable content. With ``i`` on and no VLM role
available the analyze stage fails the document loudly
(``MultimodalAnalysisError``) instead of ingesting an unsearchable shell
— configure ``VLM_PROCESS_ENABLE`` plus the ``vlm`` role first.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

from lightrag.constants import PARSER_ENGINE_IMAGE
from lightrag.llm._vision_utils import read_image_dimensions
from lightrag.parser.native_base import NativeExtractRuntime, NativeParserBase
from lightrag.parser.registry import IMAGE_ENGINE_SUFFIXES

if TYPE_CHECKING:
    from lightrag.sidecar.ir import IRDoc

_SOURCE_SUFFIXES = frozenset(f".{suffix}" for suffix in IMAGE_ENGINE_SUFFIXES)

_PLACEHOLDER_KEY = "im1"


class NativeImageParser(NativeParserBase):
    engine_name = PARSER_ENGINE_IMAGE
    empty_content_label = "Image"

    def validate_source(self, source: Path, file_path: str) -> None:
        if not (
            source.exists()
            and source.is_file()
            and source.suffix.lower() in _SOURCE_SUFFIXES
        ):
            raise ValueError(
                f"Native image parser does not support pending file: {file_path}"
            )

    def validate_source_blocking(self, source: Path, file_path: str) -> None:
        # Header-level gate, matching the formats the VLM raster path can
        # consume; a corrupt upload fails here instead of minting a sidecar
        # the analyze stage would then skip as undecodable.
        if read_image_dimensions(source) is None:
            raise ValueError(
                f"Native image parser cannot decode image header: {file_path} "
                "(expected PNG/JPEG/GIF/WebP)"
            )

    def extract(
        self,
        source: Path,
        *,
        parsed_dir: Path,
        asset_dir: Path,
        base_name: str,
        runtime: NativeExtractRuntime | None = None,
    ) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
        suffix = source.suffix.lower().lstrip(".")
        blocks = [
            {
                "content": f"{{{{IMG:{_PLACEHOLDER_KEY}}}}}",
                "heading": base_name,
                "drawing": {
                    "placeholder_key": _PLACEHOLDER_KEY,
                    "asset_ref": _PLACEHOLDER_KEY,
                    "fmt": suffix,
                },
            }
        ]
        metadata = {"source_path": str(source)}
        return blocks, {}, metadata

    def build_ir(
        self,
        blocks: list[dict[str, Any]],
        *,
        document_name: str,
        asset_dir_name: str,
        metadata: dict[str, Any],
    ) -> "IRDoc":
        from lightrag.sidecar.ir import (
            AssetSpec,
            IRBlock,
            IRDoc,
            IRDrawing,
            IRPosition,
        )

        source_path = Path(metadata["source_path"])
        stem = Path(document_name).stem or document_name
        ir_blocks: list[IRBlock] = []
        assets: list[AssetSpec] = []
        for block in blocks:
            spec = block["drawing"]
            heading = str(block.get("heading") or stem)
            assets.append(
                AssetSpec(
                    ref=spec["asset_ref"],
                    suggested_name=source_path.name,
                    source=source_path,
                )
            )
            ir_blocks.append(
                IRBlock(
                    content_template=block["content"],
                    heading=heading,
                    level=1,
                    positions=[IRPosition(type="heading", anchor=heading)],
                    drawings=[
                        IRDrawing(
                            placeholder_key=spec["placeholder_key"],
                            asset_ref=spec["asset_ref"],
                            fmt=str(spec.get("fmt") or ""),
                        )
                    ],
                )
            )
        return IRDoc(
            document_name=document_name,
            document_format=source_path.suffix.lower().lstrip("."),
            doc_title=stem,
            split_option={},
            blocks=ir_blocks,
            assets=assets,
            bbox_attributes=None,
        )


__all__ = ["NativeImageParser"]
