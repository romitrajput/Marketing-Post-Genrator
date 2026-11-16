import type { Box } from './types';
import { rgbToHex } from './image';

export interface TextPixels {
  box: Box; // padded box actually analysed
  mask: Uint8Array; // box-sized 0/255 glyph mask
  textColor: string;
  bgColor: string;
  contrast: number; // RGB distance between text and local background
}

/**
 * Separates glyph pixels from their local background inside an OCR box by colour:
 * background = median of the box border, text = mean of the 15% of pixels most
 * different from it; each pixel goes to whichever is closer.
 */
export function textPixels(img: ImageData, b: Box): TextPixels {
  const W = img.width, H = img.height, d = img.data;
  const pad = Math.max(2, Math.round(b.h * 0.12));
  const x0 = Math.max(0, b.x - pad), y0 = Math.max(0, b.y - pad);
  const x1 = Math.min(W, b.x + b.w + pad), y1 = Math.min(H, b.y + b.h + pad);
  const w = x1 - x0, h = y1 - y0;
  const border: number[][] = [];
  for (let x = x0; x < x1; x++) { border.push(px(x, y0)); border.push(px(x, y1 - 1)); }
  for (let y = y0; y < y1; y++) { border.push(px(x0, y)); border.push(px(x1 - 1, y)); }
  const bg = [0, 1, 2].map((k) => median(border.map((c) => c[k])));
  const dist = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = px(x0 + x, y0 + y);
    dist[y * w + x] = Math.hypot(c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]);
  }
  const sorted = Float32Array.from(dist).sort();
  const cut = sorted[Math.floor(sorted.length * 0.85)];
  const acc = [0, 0, 0];
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (dist[y * w + x] >= cut) {
    const c = px(x0 + x, y0 + y);
    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; n++;
  }
  const fg = acc.map((v) => v / Math.max(1, n));
  const contrast = Math.hypot(fg[0] - bg[0], fg[1] - bg[1], fg[2] - bg[2]);
  const mask = new Uint8Array(w * h);
  if (contrast > 25) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = px(x0 + x, y0 + y);
      const dt = Math.hypot(c[0] - fg[0], c[1] - fg[1], c[2] - fg[2]);
      const db = dist[y * w + x];
      // soft edge: anti-aliased glyph borders get partial alpha
      const t = db / (db + dt + 1e-6);
      mask[y * w + x] = t > 0.62 ? 255 : t < 0.38 ? 0 : Math.round(((t - 0.38) / 0.24) * 255);
    }
  }
  return { box: { x: x0, y: y0, w, h }, mask, textColor: rgbToHex(fg[0], fg[1], fg[2]), bgColor: rgbToHex(bg[0], bg[1], bg[2]), contrast };

  function px(x: number, y: number) {
    const i = (y * W + x) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  }
}

function median(a: number[]): number {
  const s = [...a].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/** Rough CSS font size (px) for a line of OCR'd text of height `h`. */
export function estimateFontSize(text: string, h: number): number {
  const hasDescender = /[gjpqy]/.test(text);
  const allCaps = text === text.toUpperCase();
  const k = allCaps && !hasDescender ? 1.38 : hasDescender ? 1.0 : 1.2;
  return Math.max(8, Math.round(h * k));
}
