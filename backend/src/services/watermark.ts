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

class MarkerWatermarker implements WatermarkAdapter {
  async watermark(
    buf: Buffer,
    mime: string,
    meta: Record<string, string>
  ): Promise<Buffer> {
    if (textLike(mime)) {
      const stamp = `\n<!-- escrow-watermark ${JSON.stringify(meta)} -->\n`;
      return Buffer.concat([buf, Buffer.from(stamp)]);
    }
    // binary: append a delimited JSON trailer; consumers must strip before use.
    const payload = JSON.stringify({ __escrow_wm: meta });
    const trailer = Buffer.from(`\u0000ESCROW_WM\u0000${payload}\u0000`);
    return Buffer.concat([buf, trailer]);
  }
}

let adapter: WatermarkAdapter | null = null;

export function watermarker(): WatermarkAdapter {
  if (!adapter) adapter = new MarkerWatermarker();
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
