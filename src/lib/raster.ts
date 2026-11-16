import { blurMask, canvasToBlob, createCanvas, ctx2d, loadImageElement } from './image';

export interface ColorStats {
  mean: number[];
  std: number[];
}

/** Mean / std of RGB over pixels with alpha > 128. */
export function colorStats(data: ImageData): ColorStats | null {
  const sum = [0, 0, 0], sq = [0, 0, 0];
  let n = 0;
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    for (let k = 0; k < 3; k++) {
      sum[k] += d[i + k];
      sq[k] += d[i + k] * d[i + k];
    }
    n++;
  }
  if (n < 16) return null;
  const mean = sum.map((s) => s / n);
  const std = sq.map((q, k) => Math.sqrt(Math.max(1, q / n - mean[k] ** 2)));
  return { mean, std };
}

export async function urlStats(url: string): Promise<ColorStats | null> {
  const img = await loadImageElement(url);
  const s = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = createCanvas(img.naturalWidth * s, img.naturalHeight * s);
  const ctx = ctx2d(c);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return colorStats(ctx.getImageData(0, 0, c.width, c.height));
}

/**
 * Non-destructive raster pipeline for cut-out layers: always starts from the
 * untouched base cut-out, then applies colour matching and edge feathering.
 */
export async function processRaster(
  baseSrc: string,
  opts: { feather?: number; colorMatch?: ColorStats | null; strength?: number },
): Promise<string> {
  const img = await loadImageElement(baseSrc);
  const c = createCanvas(img.naturalWidth, img.naturalHeight);
  const ctx = ctx2d(c);
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const d = data.data;
  if (opts.colorMatch) {
    const src = colorStats(data);
    if (src) {
      const k = opts.strength ?? 0.65;
      const t = opts.colorMatch;
      for (let i = 0; i < d.length; i += 4) {
        if (!d[i + 3]) continue;
        for (let ch = 0; ch < 3; ch++) {
          const v = d[i + ch];
          const target = ((v - src.mean[ch]) * Math.min(2, t.std[ch] / src.std[ch])) + t.mean[ch];
          d[i + ch] = v + k * (target - v);
        }
      }
    }
  }
  const r = Math.round(opts.feather ?? 0);
  if (r > 0) {
    const a = new Uint8Array(c.width * c.height);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    // erode-then-blur style inward feather: min(original, blurred)
    const b = blurMask(a, c.width, c.height, r);
    for (let i = 0; i < a.length; i++) d[i * 4 + 3] = Math.min(a[i], b[i]);
  }
  ctx.putImageData(data, 0, 0);
  return URL.createObjectURL(await canvasToBlob(c));
}

/** Paint `color` into `targetUrl` wherever `maskUrl` (placed at dx,dy in target pixels) is opaque. */
export async function repaintUnder(targetUrl: string, maskUrl: string, dx: number, dy: number, color: string, grow = 2): Promise<string> {
  const [t, m] = await Promise.all([loadImageElement(targetUrl), loadImageElement(maskUrl)]);
  const c = createCanvas(t.naturalWidth, t.naturalHeight);
  const ctx = ctx2d(c);
  ctx.drawImage(t, 0, 0);
  const mc = createCanvas(m.naturalWidth, m.naturalHeight);
  const mctx = ctx2d(mc);
  mctx.drawImage(m, 0, 0);
  const md = mctx.getImageData(0, 0, mc.width, mc.height).data;
  const a = new Uint8Array(mc.width * mc.height);
  for (let i = 0; i < a.length; i++) a[i] = md[i * 4 + 3] > 20 ? 255 : 0;
  const grown = blurMask(a, mc.width, mc.height, grow);
  const td = ctx.getImageData(0, 0, c.width, c.height);
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  for (let y = 0; y < mc.height; y++) for (let x = 0; x < mc.width; x++) {
    if (!grown[y * mc.width + x]) continue;
    const tx = Math.round(x + dx), ty = Math.round(y + dy);
    if (tx < 0 || ty < 0 || tx >= c.width || ty >= c.height) continue;
    const i = (ty * c.width + tx) * 4;
    if (td.data[i + 3] < 10) continue; // keep transparency outside the object
    td.data[i] = rgb[0];
    td.data[i + 1] = rgb[1];
    td.data[i + 2] = rgb[2];
  }
  ctx.putImageData(td, 0, 0);
  return URL.createObjectURL(await canvasToBlob(c));
}
