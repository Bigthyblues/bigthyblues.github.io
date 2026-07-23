"""Extract Toyhouse Profile sections from print-to-PDF files.

The script keeps PDF vector/text content intact by adjusting page crop boxes.
It detects Profile / Recent Images boundaries from text coordinates and removes
the repeated Toyhouse print header/footer area.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pymupdf


LEFT_MARGIN = 8.0
RIGHT_MARGIN = 8.0
TOP_MARGIN = 8.0
BOTTOM_MARGIN = 5.0


def safe_print(value: str) -> None:
    encoding = sys.stdout.encoding or "utf-8"
    print(value.encode(encoding, "backslashreplace").decode(encoding))


def text_blocks(page: pymupdf.Page) -> list[tuple]:
    return sorted(page.get_text("blocks"), key=lambda b: (round(b[1]), b[0]))


def block_text(block: tuple) -> str:
    return " ".join(block[4].split())


def find_block(page: pymupdf.Page, exact_text: str) -> tuple | None:
    for block in text_blocks(page):
        text = block_text(block)
        if text == exact_text or (
            exact_text == "Recent Images"
            and exact_text in text
            and block[0] < 60
        ):
            return block
    return None


def profile_page_crops(doc: pymupdf.Document) -> list[tuple[int, pymupdf.Rect]]:
    """Return source page numbers and rectangles covering only Profile content."""
    profile_page = None
    profile_block = None
    for page_number, page in enumerate(doc):
        match = find_block(page, "Profile")
        if match:
            profile_page, profile_block = page_number, match
            break

    if profile_page is None or profile_block is None:
        raise ValueError("Profile heading not found")

    crops: list[tuple[int, pymupdf.Rect]] = []
    for page_number in range(profile_page, len(doc)):
        page = doc[page_number]
        recent = find_block(page, "Recent Images")

        if page_number == profile_page:
            top = max(page.rect.y0, profile_block[1] - TOP_MARGIN)
        else:
            # Continuation pages begin with profile text. Find its true top so
            # the amount of whitespace stays faithful without retaining headers.
            candidates = [
                b
                for b in text_blocks(page)
                if b[0] >= 30
                and b[2] <= page.rect.width - 30
                and (recent is None or b[1] < recent[1])
                and block_text(b)
            ]
            if not candidates:
                break
            top = max(page.rect.y0, min(b[1] for b in candidates) - TOP_MARGIN)

        bottom = recent[1] - BOTTOM_MARGIN if recent else page.rect.y1
        left = max(page.rect.x0, profile_block[0] - LEFT_MARGIN)
        right = min(page.rect.x1, page.rect.width - (profile_block[0] - LEFT_MARGIN))
        if bottom <= top:
            raise ValueError(f"Invalid crop on page {page_number + 1}")
        crops.append((page_number, pymupdf.Rect(left, top, right, bottom)))

        if recent is not None:
            break

    if not crops:
        raise ValueError("Profile section is empty")
    return crops


def extract_profile(source: Path, destination: Path) -> list[pymupdf.Rect]:
    source_doc = pymupdf.open(source)
    crops = profile_page_crops(source_doc)
    output_doc = pymupdf.open()

    for source_page_number, crop in crops:
        source_page = source_doc[source_page_number]
        output_page = output_doc.new_page(width=crop.width, height=crop.height)
        output_page.show_pdf_page(output_page.rect, source_doc, source_page_number, clip=crop)

        # Restore links that intersect the retained area. show_pdf_page keeps
        # vector/text fidelity but does not copy annotations automatically.
        for link in source_page.get_links():
            source_rect = pymupdf.Rect(link["from"])
            visible = source_rect & crop
            if visible.is_empty:
                continue
            copied = dict(link)
            copied.pop("xref", None)
            copied.pop("id", None)
            copied["from"] = pymupdf.Rect(
                visible.x0 - crop.x0,
                visible.y0 - crop.y0,
                visible.x1 - crop.x0,
                visible.y1 - crop.y0,
            )
            try:
                output_page.insert_link(copied)
            except (RuntimeError, ValueError):
                # A malformed or unsupported external annotation should not
                # prevent extraction of the profile itself.
                pass

    destination.parent.mkdir(parents=True, exist_ok=True)
    output_doc.set_metadata(source_doc.metadata)
    output_doc.save(destination, garbage=4, deflate=True)
    output_doc.close()
    source_doc.close()
    return [crop for _, crop in crops]


def print_debug(pdf_path: Path) -> None:
    doc = pymupdf.open(pdf_path)
    safe_print(f"{pdf_path}: {len(doc)} pages")
    for page_number, page in enumerate(doc, 1):
        safe_print(f"  page {page_number}: {page.rect}")
        for block in text_blocks(page):
            x0, y0, x1, y1, text = block[:5]
            clean = " ".join(text.split())
            safe_print(f"    ({x0:6.1f}, {y0:6.1f})-({x1:6.1f}, {y1:6.1f}) {clean[:100]}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Batch-extract Toyhouse Profile sections while preserving PDF formatting."
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()
    if args.debug:
        paths = [args.source] if args.source.is_file() else sorted(args.source.rglob("*.pdf"))
        for path in paths:
            print_debug(path)
        return

    if not args.source.is_dir():
        parser.error("For batch extraction, source must be a directory")
    output_root = args.output or args.source.with_name(args.source.name.replace(" pdf", " profile pdf"))
    paths = sorted(args.source.rglob("*.pdf"))
    if not paths:
        parser.error(f"No PDF files found under {args.source}")

    failures: list[tuple[Path, Exception]] = []
    for source in paths:
        relative = source.relative_to(args.source)
        destination = output_root / relative
        try:
            crops = extract_profile(source, destination)
            sizes = ", ".join(f"{r.width:.1f}x{r.height:.1f}" for r in crops)
            safe_print(f"OK  {relative} -> {len(crops)} page(s) [{sizes}]")
        except Exception as exc:  # continue and report every problematic file
            failures.append((relative, exc))
            safe_print(f"ERR {relative}: {exc}")

    safe_print(f"\nCreated {len(paths) - len(failures)}/{len(paths)} PDFs in {output_root}")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
