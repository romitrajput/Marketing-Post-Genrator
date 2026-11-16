import type { Box, SourceImage } from './types';

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // hard limit for decoding
/** Longest side used for processing. Larger images are offered a resize. */
export const MAX_PROCESS_SIDE = 2048;
/** Images whose longest side exceeds this cannot be processed at all. */
export const MAX_DECODE_SIDE = 8000;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

let idCounter = 0;
export function uid(prefix = 'l'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The browser could not decode this image.'));
    img.src = url;
  });
}

export function validateFile(file: File): string | null {
  const type = file.type || guessType(file.name);
  if (!ACCEPTED_TYPES.includes(type)) return `Unsupported file type (${file.type || 'unknown'}). Use JPG, PNG or WEBP.`;
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_FILE_BYTES) return `File is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_FILE_BYTES)}.`;
  return null;
}

function guessType(name: string): string {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return '';
}

/** Decode a blob and describe it. Throws a user-readable error on failure. */
export async function readSource(blob: Blob, name: string): Promise<SourceImage> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImageElement(url);
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('Image has no pixels.');
    if (Math.max(img.naturalWidth, img.naturalHeight) > MAX_DECODE_SIDE)
      throw new Error(`Image is ${img.naturalWidth}×${img.naturalHeight}px; the maximum is ${MAX_DECODE_SIDE}px on the longest side.`);
    return {
      blob,
      url,
      name,
      width: img.naturalWidth,
      height: img.naturalHeight,
      bytes: blob.size,
      type: blob.type || guessType(name),
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D is not available in this browser.');
  return ctx;
}

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image (out of memory?).'))), type, quality),
  );
}

/** Resize so that the longest side is at most `maxSide`. Returns a new PNG/JPEG blob. */
export async function resizeBlob(src: SourceImage, maxSide: number): Promise<Blob> {
  const img = await loadImageElement(src.url);
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = createCanvas(img.naturalWidth * s, img.naturalHeight * s);
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const type = src.type === 'image/png' ? 'image/png' : 'image/jpeg';
  return canvasToBlob(c, type, 0.95);
}

export async function urlToImageData(url: string, w?: number, h?: number): Promise<ImageData> {
  const img = await loadImageElement(url);
  const c = createCanvas(w ?? img.naturalWidth, h ?? img.naturalHeight);
  const ctx = ctx2d(c);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

export function imageDataToCanvas(data: ImageData): HTMLCanvasElement {
  const c = createCanvas(data.width, data.height);
  ctx2d(c).putImageData(data, 0, 0);
  return c;
}

export async function imageDataToUrl(data: ImageData): Promise<string> {
  const blob = await canvasToBlob(imageDataToCanvas(data));
  return URL.createObjectURL(blob);
}

/** Bounding box of mask pixels > threshold. Returns null for empty masks. */
export function maskBBox(mask: Uint8Array | Uint8ClampedArray, w: number, h: number, threshold = 0): Box | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[row + x] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Cut `mask` (full-size, 0..255 alpha) out of `src` and return a transparent PNG
 * cropped to the mask's bounding box (optionally limited to `limit`).
 */
export async function cutout(
  src: ImageData,
  mask: Uint8Array | Uint8ClampedArray,
  limit?: Box,
): Promise<{ url: string; blob: Blob; box: Box; coverage: number } | null> {
  const { width: W, height: H } = src;
  const bb = maskBBox(mask, W, H, 8);
  if (!bb) return null;
  let box = bb;
  if (limit) {
    const x = Math.max(bb.x, limit.x), y = Math.max(bb.y, limit.y);
    const x2 = Math.min(bb.x + bb.w, limit.x + limit.w), y2 = Math.min(bb.y + bb.h, limit.y + limit.h);
    if (x2 <= x || y2 <= y) return null;
    box = { x, y, w: x2 - x, h: y2 - y };
  }
  const out = new ImageData(box.w, box.h);
  let covered = 0;
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const si = (box.y + y) * W + (box.x + x);
      const di = (y * box.w + x) * 4;
      const a = mask[si];
      out.data[di] = src.data[si * 4];
      out.data[di + 1] = src.data[si * 4 + 1];
      out.data[di + 2] = src.data[si * 4 + 2];
      out.data[di + 3] = Math.round((src.data[si * 4 + 3] * a) / 255);
      if (a > 127) covered++;
    }
  }
  const blob = await canvasToBlob(imageDataToCanvas(out));
  return { url: URL.createObjectURL(blob), blob, box, coverage: covered / (box.w * box.h) };
}

/** Returns a copy of `src` with alpha multiplied by (255 - mask). */
export function eraseMask(src: ImageData, mask: Uint8Array | Uint8ClampedArray): ImageData {
  const out = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) out.data[i * 4 + 3] = Math.round((out.data[i * 4 + 3] * (255 - mask[i])) / 255);
  }
  return out;
}

/** Alpha channel of an ImageData as a mask. */
export function alphaOf(data: ImageData): Uint8Array {
  const m = new Uint8Array(data.width * data.height);
  for (let i = 0; i < m.length; i++) m[i] = data.data[i * 4 + 3];
  return m;
}

/** Separable box blur of a single-channel mask (used for feathering). */
export function blurMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r < 1) return mask.slice();
  const tmp = new Float32Array(w * h);
  const out = new Uint8Array(w * h);
  const d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += mask[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / d;
      const add = Math.min(w - 1, x + r + 1), sub = Math.max(0, x - r);
      acc += mask[y * w + add] - mask[y * w + sub];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = Math.round(acc / d);
      const add = Math.min(h - 1, y + r + 1), sub = Math.max(0, y - r);
      acc += tmp[add * w + x] - tmp[sub * w + x];
    }
  }
  return out;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

export function safeFileName(s: string): string {
  return s.replace(/[^a-z0-9\-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'remix';
}
