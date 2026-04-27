/**
 * PDF processing utilities for the export pipeline — extract specified
 * pages from source PDFs (labelled) and merge them into one combined PDF.
 */
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import * as fs from "fs";
import * as path from "path";

let _fontBytes: Buffer | null = null;

// Prefer a Noto Sans JP subset (~2MB) for cold-start speed; fall back to the
// full yumin.ttf (~13MB) so this works without the subset asset being created.
const FONT_CANDIDATES = [
  "assets/fonts/NotoSansJP-Regular.subset.ttf",
  "assets/fonts/yumin.ttf",
];

function loadFontBytes(): Buffer {
  if (_fontBytes) return _fontBytes;
  for (const rel of FONT_CANDIDATES) {
    const abs = path.join(process.cwd(), rel);
    if (fs.existsSync(abs)) {
      _fontBytes = fs.readFileSync(abs);
      return _fontBytes;
    }
  }
  throw new Error(
    `No font asset found. Expected one of: ${FONT_CANDIDATES.join(", ")} under ${process.cwd()}`,
  );
}

/**
 * Extract specified pages from a PDF and add a label in the top-left corner.
 */
export async function extractAndLabel(
  pdfBuffer: ArrayBuffer | Uint8Array,
  pageIndices: number[],
  label: string,
): Promise<Uint8Array> {
  const bytes = pdfBuffer instanceof Uint8Array
    ? new Uint8Array(pdfBuffer)
    : new Uint8Array(pdfBuffer);
  const srcDoc = await PDFDocument.load(bytes);
  const dstDoc = await PDFDocument.create();
  dstDoc.registerFontkit(fontkit);

  const fontBytes = loadFontBytes();
  const font = await dstDoc.embedFont(fontBytes);

  const copiedPages = await dstDoc.copyPages(srcDoc, pageIndices);
  for (const page of copiedPages) {
    dstDoc.addPage(page);
    const { height } = page.getSize();
    page.drawText(label, {
      x: 10,
      y: height - 15,
      size: 9,
      font,
      color: rgb(0.6, 0.6, 0.6),
    });
  }

  return dstDoc.save();
}

export async function mergePdfs(
  pdfBuffers: ArrayBuffer[],
): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  for (const buf of pdfBuffers) {
    const src = await PDFDocument.load(buf);
    const pages = await merged.copyPages(src, src.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  return merged.save();
}
