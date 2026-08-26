import { createHash } from "node:crypto";

/**
 * Watermarking lives off-chain (spec §4). v1 ships a passthrough-ish marker:
 * text-like payloads get an embedded provenance comment; binaries are copied
 * byte-for-byte with a sidecar hash. Swap this adapter for sharp/pdf-lib
 * visual stamping without touching route code.
 */
export interface WatermarkAdapter {
  watermark(buf: Buffer, mime: string, meta: Record<string, string>): Promise<Buffer>;
}

function textLike(mime: string): boolean {
  return /^(text\/|application\/json|application\/xml|application\/svg)/.test(mime);
}

function isImage(mime: string): boolean {
  return /^image\/(png|jpeg|jpg|webp|gif|tiff|bmp)/.test(mime);
}

function isPdf(mime: string): boolean {
  return mime === "application/pdf";
}

/** Visual watermark using sharp for images, pdf-lib for PDFs, marker for everything else. */
class VisualWatermarker implements WatermarkAdapter {
  async watermark(
    buf: Buffer,
    mime: string,
    meta: Record<string, string>
  ): Promise<Buffer> {
    const label = meta.projectId
      ? `ESCROW ${meta.projectId.slice(0, 8)}`
      : "ESCROW";

    if (isImage(mime)) {
      return this.watermarkImage(buf, mime, label);
    }
    if (isPdf(mime)) {
      return this.watermarkPdf(buf, label);
    }
    if (textLike(mime)) {
      return this.watermarkText(buf, meta);
    }
    return this.watermarkBinary(buf, meta);
  }

  private async watermarkImage(buf: Buffer, _mime: string, label: string): Promise<Buffer> {
    try {
      const sharp = (await import("sharp")).default;
      const svgOverlay = Buffer.from(`
        <svg width="100%" height="100%">
          <style>
            text { font: bold 48px sans-serif; fill: rgba(255,255,255,0.15); }
          </style>
          <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
                transform="rotate(-30 50% 50%)">${label}</text>
        </svg>
      `);

      return await sharp(buf)
        .composite([{ input: svgOverlay, blend: "over" }])
        .toBuffer();
    } catch (err) {
      console.warn("[watermark] sharp failed, falling back to marker:", err);
      return this.watermarkBinary(buf, { label });
    }
  }

  private async watermarkPdf(buf: Buffer, label: string): Promise<Buffer> {
    try {
      const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");
      const pdf = await PDFDocument.load(buf);
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const pages = pdf.getPages();

      for (const page of pages) {
        const { width, height } = page.getSize();
        page.drawText(label, {
          x: width / 2 - font.widthOfTextAtSize(label, 36) / 2,
          y: height / 2,
          size: 36,
          font,
          color: rgb(0.85, 0.85, 0.85),
          opacity: 0.3
        });
      }

      return Buffer.from(await pdf.save());
    } catch (err) {
      console.warn("[watermark] pdf-lib failed, falling back to marker:", err);
      return this.watermarkBinary(buf, { label });
    }
  }

  private async watermarkText(buf: Buffer, meta: Record<string, string>): Promise<Buffer> {
    const stamp = `\n<!-- escrow-watermark ${JSON.stringify(meta)} -->\n`;
    return Buffer.concat([buf, Buffer.from(stamp)]);
  }

  private async watermarkBinary(buf: Buffer, meta: Record<string, string>): Promise<Buffer> {
    const payload = JSON.stringify({ __escrow_wm: meta });
    const trailer = Buffer.from(`\u0000ESCROW_WM\u0000${payload}\u0000`);
    return Buffer.concat([buf, trailer]);
  }
}

let adapter: WatermarkAdapter | null = null;

export function watermarker(): WatermarkAdapter {
  if (!adapter) adapter = new VisualWatermarker();
  return adapter;
}

export function stripBinaryWatermark(buf: Buffer): Buffer {
  const idx = buf.indexOf(Buffer.from("\u0000ESCROW_WM\u0000"));
  if (idx === -1) return buf;
  return buf.subarray(0, idx);
}

export function previewHash(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
