/*
 * OpenCV.js worker. Everything heavy (GrabCut, watershed, contours, inpainting)
 * runs here so the editor UI never freezes.
 *
 * This file is deliberately self-contained (no runtime imports): it is built as a
 * classic worker so it can `importScripts()` the 10 MB opencv.js that
 * scripts/copy-assets.mjs places in public/opencv/.
 */
import type { Box } from '../lib/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CV = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mat = any;

const GC_BGD = 0, GC_FGD = 1, GC_PR_BGD = 2, GC_PR_FGD = 3;
const CDN_FALLBACK = 'https://docs.opencv.org/4.10.0/opencv.js';

interface Scope {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
  importScripts(...urls: string[]): void;
  cv?: CV;
}
const scope = self as unknown as Scope;
let cv: CV = null;
let source = '';

async function init(baseUrl: string): Promise<{ source: string; version: string }> {
  if (cv) return { source, version: String(cv.getBuildInformation?.().match(/Version control:\s*(\S+)/)?.[1] ?? '4.x') };
  const local = new URL('opencv/opencv.js', baseUrl).href;
  try {
    scope.importScripts(local);
    source = 'self-hosted';
  } catch {
    scope.importScripts(CDN_FALLBACK);
    source = 'docs.opencv.org CDN (fallback)';
  }
  let mod: CV = scope.cv;
  if (!mod) throw new Error('opencv.js loaded but did not define `cv`.');
  if (mod instanceof Promise) mod = await mod;
  if (!mod.Mat) {
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const prev = mod.onRuntimeInitialized;
      mod.onRuntimeInitialized = () => {
        prev?.();
        resolve();
      };
      const poll = setInterval(() => {
        if (mod.Mat) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() - started > 90000) {
          clearInterval(poll);
          reject(new Error('OpenCV runtime did not initialise within 90 s.'));
        }
      }, 100);
    });
  }
  cv = mod;
  return { source, version: '4.x' };
}

// ---------------------------------------------------------------- helpers
function rgbaMat(buf: ArrayBuffer, w: number, h: number): Mat {
  const m = new cv.Mat(h, w, cv.CV_8UC4);
  m.data.set(new Uint8Array(buf));
  return m;
}
function grayMat(arr: Uint8Array, w: number, h: number): Mat {
  const m = new cv.Mat(h, w, cv.CV_8UC1);
  m.data.set(arr);
  return m;
}
function resized(src: Mat, w: number, h: number, interp: number): Mat {
  const dst = new cv.Mat();
  cv.resize(src, dst, new cv.Size(w, h), 0, 0, interp);
  return dst;
}
function rgbOf(rgba: Mat): Mat {
  const dst = new cv.Mat();
  cv.cvtColor(rgba, dst, cv.COLOR_RGBA2RGB);
  return dst;
}
function kernel(n: number): Mat {
  return cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(n, n));
}
function morph(m: Mat, op: number, n: number, iterations = 1) {
  const k = kernel(n);
  cv.morphologyEx(m, m, op, k, new cv.Point(-1, -1), iterations);
  k.delete();
}
function dilate(m: Mat, n: number, iterations = 1) {
  const k = kernel(n);
  cv.dilate(m, m, k, new cv.Point(-1, -1), iterations);
  k.delete();
}
function erode(m: Mat, n: number, iterations = 1) {
  const k = kernel(n);
  cv.erode(m, m, k, new cv.Point(-1, -1), iterations);
  k.delete();
}
function analysisSize(w: number, h: number, maxSide: number) {
  const s = Math.min(1, maxSide / Math.max(w, h));
  return { s, aw: Math.max(1, Math.round(w * s)), ah: Math.max(1, Math.round(h * s)) };
}
/** Upsample a 0/255 mask to full res with soft (anti-aliased) edges. */
function upsampleMask(small: Mat, W: number, H: number): Uint8Array {
  const big = resized(small, W, H, cv.INTER_LINEAR);
  const blurred = new cv.Mat();
  cv.GaussianBlur(big, blurred, new cv.Size(3, 3), 0);
  const out = new Uint8Array(blurred.data);
  big.delete();
  blurred.delete();
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    out[i] = v < 48 ? 0 : v > 208 ? 255 : Math.round(((v - 48) / 160) * 255);
  }
  return out;
}
function cropMask(full: Uint8Array, W: number, box: Box): Uint8Array {
  const out = new Uint8Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) out.set(full.subarray((box.y + y) * W + box.x, (box.y + y) * W + box.x + box.w), y * box.w);
  return out;
}

/** Simple k-means on RGB samples (used on border pixels to model the background). */
function kmeans(px: Float32Array, k: number, iters = 10): { centers: number[][]; share: number[] } {
  const n = px.length / 3;
  const centers: number[][] = [];
  for (let i = 0; i < k; i++) {
    const j = Math.floor(((i + 0.5) / k) * n) * 3;
    centers.push([px[j], px[j + 1], px[j + 2]]);
  }
  const lab = new Uint8Array(n);
  for (let it = 0; it < iters; it++) {
    const sum = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (px[i * 3] - centers[c][0]) ** 2 + (px[i * 3 + 1] - centers[c][1]) ** 2 + (px[i * 3 + 2] - centers[c][2]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      lab[i] = best;
      const s = sum[best];
      s[0] += px[i * 3]; s[1] += px[i * 3 + 1]; s[2] += px[i * 3 + 2]; s[3]++;
    }
    for (let c = 0; c < k; c++) if (sum[c][3]) centers[c] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]];
  }
  const share = centers.map(() => 0);
  for (let i = 0; i < n; i++) share[lab[i]]++;
  return { centers, share: share.map((v) => v / n) };
}

/** 4-connected component labelling of a 0/255 mask. Returns labels + per-label stats. */
function components(mask: Uint8Array, w: number, h: number) {
  const labels = new Int32Array(w * h);
  const stats: { label: number; area: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  const stack = new Int32Array(w * h);
  let next = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    next++;
    let sp = 0, area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[sp++] = i;
    labels[i] = next;
    while (sp) {
      const p = stack[--sp];
      const x = p % w, y = (p / w) | 0;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = next; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = next; stack[sp++] = p + w; }
    }
    stats.push({ label: next, area, x0, y0, x1, y1 });
  }
  stats.sort((a, b) => b.area - a.area);
  return { labels, stats };
}

function borderTouch(mask: Uint8Array, w: number, h: number, b: number): number {
  let on = 0, total = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x <= b || y <= b || x >= w - 1 - b || y >= h - 1 - b) {
      total++;
      if (mask[y * w + x]) on++;
    }
  }
  return on / total;
}

// ---------------------------------------------------------------- foreground
interface FgParams {
  rgba: ArrayBuffer;
  w: number;
  h: number;
  textBoxes: Box[];
  glyph?: ArrayBuffer; // full-res 0/255 text pixel mask
  rect?: Box; // optional user rectangle (full-res) — outside is background
  maxSecondary?: number;
}

function foreground(p: FgParams) {
  const { w: W, h: H } = p;
  const { s, aw, ah } = analysisSize(W, H, 640);
  const log: string[] = [];
  const full = rgbaMat(p.rgba, W, H);
  const smallRgba = resized(full, aw, ah, cv.INTER_AREA);
  full.delete();
  const img = rgbOf(smallRgba);
  smallRgba.delete();
  const px = img.data as Uint8Array;
  const n = aw * ah;

  // 1. initial GrabCut labels
  const labels = new Uint8Array(n).fill(GC_PR_FGD);
  const b = Math.max(4, Math.round(Math.min(aw, ah) * 0.03));
  const border: number[] = [];
  for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
    if (x < b || y < b || x >= aw - b || y >= ah - b) {
      const i = (y * aw + x) * 3;
      border.push(px[i], px[i + 1], px[i + 2]);
    }
  }
  const km = kmeans(new Float32Array(border), 3);
  const bgCenters = km.centers.filter((_, i) => km.share[i] > 0.15);
  let bgLike = 0;
  for (let i = 0; i < n; i++) {
    for (const c of bgCenters) {
      const d = (px[i * 3] - c[0]) ** 2 + (px[i * 3 + 1] - c[1]) ** 2 + (px[i * 3 + 2] - c[2]) ** 2;
      if (d < 28 * 28) { labels[i] = GC_PR_BGD; bgLike++; break; }
    }
  }
  log.push(`Background colour model: ${bgCenters.length} dominant border colour(s), ${(100 * bgLike / n).toFixed(0)}% of pixels similar.`);
  const tb = p.textBoxes.map((t) => ({
    x: Math.floor(t.x * s), y: Math.floor(t.y * s), w: Math.ceil(t.w * s) + 1, h: Math.ceil(t.h * s) + 1,
  }));
  for (const t of tb) for (let y = Math.max(0, t.y); y < Math.min(ah, t.y + t.h); y++)
    for (let x = Math.max(0, t.x); x < Math.min(aw, t.x + t.w); x++) labels[y * aw + x] = GC_PR_BGD;
  if (p.rect) {
    const r = { x: p.rect.x * s, y: p.rect.y * s, w: p.rect.w * s, h: p.rect.h * s };
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++)
      if (x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h) labels[y * aw + x] = GC_BGD;
  }
  for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++)
    if (x < b || y < b || x >= aw - b || y >= ah - b) labels[y * aw + x] = GC_BGD;
  // GrabCut needs at least some foreground candidates
  let prFg = 0;
  for (let i = 0; i < n; i++) if (labels[i] === GC_PR_FGD) prFg++;
  if (prFg < n * 0.002) {
    for (let y = Math.round(ah * 0.15); y < Math.round(ah * 0.85); y++)
      for (let x = Math.round(aw * 0.15); x < Math.round(aw * 0.85); x++) if (labels[y * aw + x] !== GC_BGD) labels[y * aw + x] = GC_PR_FGD;
    log.push('Few foreground candidates; widened the search to the centre of the image.');
  }

  // 2. GrabCut
  const mask = grayMat(labels, aw, ah);
  const bgd = new cv.Mat(), fgd = new cv.Mat();
  cv.grabCut(img, mask, new cv.Rect(0, 0, 1, 1), bgd, fgd, 5, cv.GC_INIT_WITH_MASK);
  bgd.delete(); fgd.delete();
  const md = mask.data as Uint8Array;
  const fgArr = new Uint8Array(n);
  for (let i = 0; i < n; i++) fgArr[i] = md[i] === GC_FGD || md[i] === GC_PR_FGD ? 255 : 0;
  mask.delete();
  const fg = grayMat(fgArr, aw, ah);
  morph(fg, cv.MORPH_OPEN, 3);
  morph(fg, cv.MORPH_CLOSE, 7);

  // 3. text interplay: text sitting on the object stays part of it, other glyphs are cut out
  // (glyph mask is prepared first: any OpenCV allocation can grow the WASM heap and
  //  detach previously obtained `.data` views)
  let glyphSmall: Uint8Array | null = null;
  if (p.glyph) {
    const g = grayMat(new Uint8Array(p.glyph), W, H);
    const gs = resized(g, aw, ah, cv.INTER_AREA);
    g.delete();
    cv.threshold(gs, gs, 0, 255, cv.THRESH_BINARY);
    dilate(gs, 3, 1);
    glyphSmall = new Uint8Array(gs.data);
    gs.delete();
  }
  const fgd2 = fg.data as Uint8Array;
  const onObject = tb.map((t) => {
    const pad = Math.max(3, Math.round(Math.min(t.w, t.h) * 0.4));
    let on = 0, tot = 0;
    for (let y = t.y - pad; y < t.y + t.h + pad; y++) for (let x = t.x - pad; x < t.x + t.w + pad; x++) {
      if (x < 0 || y < 0 || x >= aw || y >= ah) continue;
      const inside = x >= t.x && y >= t.y && x < t.x + t.w && y < t.y + t.h;
      if (inside) continue;
      tot++;
      if (fgd2[y * aw + x]) on++;
    }
    return tot > 0 && on / tot > 0.6;
  });
  tb.forEach((t, i) => {
    if (!onObject[i]) return;
    for (let y = Math.max(0, t.y); y < Math.min(ah, t.y + t.h); y++)
      for (let x = Math.max(0, t.x); x < Math.min(aw, t.x + t.w); x++) fgd2[y * aw + x] = 255;
  });
  if (glyphSmall) {
    const gd = glyphSmall;
    const inOnObjectBox = (x: number, y: number) =>
      tb.some((t, i) => onObject[i] && x >= t.x && y >= t.y && x < t.x + t.w && y < t.y + t.h);
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
      const i = y * aw + x;
      if (gd[i] && !inOnObjectBox(x, y)) fgd2[i] = 0;
    }
  }

  // 4. connected components -> main subject + secondary objects
  const fgCopy = new Uint8Array(fg.data);
  const { labels: lab, stats } = components(fgCopy, aw, ah);
  if (!stats.length) {
    fg.delete(); img.delete();
    return { found: false, log: [...log, 'GrabCut found no foreground.'], onObject };
  }
  const mainStat = stats[0];
  let main: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) main[i] = lab[i] === mainStat.label ? 255 : 0;

  // 5. watershed refinement of the main boundary (kept only if it is sane)
  try {
    const refined = watershedRefine(img, main, aw, ah);
    if (refined) {
      let a0 = 0, a1 = 0;
      for (let i = 0; i < n; i++) { if (main[i]) a0++; if (refined[i]) a1++; }
      if (a1 > a0 * 0.85 && a1 < a0 * 1.15) { main = refined; log.push('Watershed refined the subject boundary.'); }
      else log.push('Watershed result rejected (area changed too much); kept GrabCut boundary.');
    }
  } catch (e) {
    log.push('Watershed unavailable: ' + (e as Error).message);
  }
  const ratio = mainStat.area / n;
  const bt = borderTouch(main, aw, ah, b);
  const confidence = ratio > 0.04 && ratio < 0.7 && bt < 0.15 ? 'high' : ratio > 0.015 && ratio < 0.88 ? 'medium' : 'manual';
  log.push(`Main subject: ${(ratio * 100).toFixed(1)}% of image, touches border ${(bt * 100).toFixed(0)}% -> ${confidence}.`);

  const mainSmall = grayMat(main, aw, ah);
  const mainFull = upsampleMask(mainSmall, W, H);
  mainSmall.delete();

  const secondary: { box: Box; mask: Uint8Array; areaRatio: number }[] = [];
  for (const st of stats.slice(1, 1 + (p.maxSecondary ?? 5))) {
    if (st.area / n < 0.006) break;
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = lab[i] === st.label ? 255 : 0;
    const ms = grayMat(m, aw, ah);
    const mf = upsampleMask(ms, W, H);
    ms.delete();
    const box = fullBox(st, s, W, H);
    secondary.push({ box, mask: cropMask(mf, W, box), areaRatio: st.area / n });
  }
  fg.delete(); img.delete();
  const mainBox = fullBox(mainStat, s, W, H);
  return {
    found: true,
    log,
    onObject,
    main: { box: mainBox, mask: cropMask(mainFull, W, mainBox), confidence, areaRatio: ratio, borderTouch: bt },
    secondary,
  };
}

function fullBox(st: { x0: number; y0: number; x1: number; y1: number }, s: number, W: number, H: number): Box {
  const pad = Math.ceil(2 / s);
  const x = Math.max(0, Math.floor(st.x0 / s) - pad), y = Math.max(0, Math.floor(st.y0 / s) - pad);
  const x2 = Math.min(W, Math.ceil((st.x1 + 1) / s) + pad), y2 = Math.min(H, Math.ceil((st.y1 + 1) / s) + pad);
  return { x, y, w: x2 - x, h: y2 - y };
}

function watershedRefine(img: Mat, main: Uint8Array, w: number, h: number): Uint8Array | null {
  if (typeof cv.watershed !== 'function') return null;
  const sure = grayMat(main, w, h);
  erode(sure, 5, 2);
  const maybe = grayMat(main, w, h);
  dilate(maybe, 5, 2);
  const markers = new cv.Mat(h, w, cv.CV_32S);
  const md = markers.data32S as Int32Array;
  const sd = sure.data as Uint8Array, bd = maybe.data as Uint8Array;
  for (let i = 0; i < w * h; i++) md[i] = sd[i] ? 2 : bd[i] ? 0 : 1;
  sure.delete(); maybe.delete();
  cv.watershed(img, markers);
  const md2 = markers.data32S as Int32Array;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = md2[i] === 2 ? 255 : 0;
  markers.delete();
  // watershed leaves -1 on boundaries; close them
  const m = grayMat(out, w, h);
  morph(m, cv.MORPH_CLOSE, 3);
  const res = new Uint8Array(m.data);
  m.delete();
  return res;
}

// ---------------------------------------------------------------- graphics / shapes
function graphics(p: { rgba: ArrayBuffer; w: number; h: number; exclude: ArrayBuffer; max?: number }) {
  const { w: W, h: H } = p;
  const { s, aw, ah } = analysisSize(W, H, 720);
  const full = rgbaMat(p.rgba, W, H);
  const small = resized(full, aw, ah, cv.INTER_AREA);
  full.delete();
  const rgb = rgbOf(small);
  small.delete();
  const gray = new cv.Mat();
  cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
  const edges = new cv.Mat();
  cv.Canny(gray, edges, 50, 150);
  gray.delete();
  dilate(edges, 3, 2);
  morph(edges, cv.MORPH_CLOSE, 9);
  const ex = grayMat(new Uint8Array(p.exclude), W, H);
  const exs = resized(ex, aw, ah, cv.INTER_AREA);
  ex.delete();
  dilate(exs, 5, 2);
  const ed = edges.data as Uint8Array, xd = exs.data as Uint8Array;
  for (let i = 0; i < aw * ah; i++) if (xd[i]) ed[i] = 0;
  exs.delete();
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(edges, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  edges.delete(); hier.delete();
  const n = aw * ah;
  const cands: { idx: number; area: number; r: { x: number; y: number; width: number; height: number } }[] = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    const r = cv.boundingRect(c);
    c.delete();
    if (area < n * 0.003 || area > n * 0.2) continue;
    const touches = [r.x <= 2, r.y <= 2, r.x + r.width >= aw - 3, r.y + r.height >= ah - 3].filter(Boolean).length;
    if (touches >= 2) continue;
    cands.push({ idx: i, area, r });
  }
  cands.sort((a, b) => b.area - a.area);
  const out: { box: Box; mask: Uint8Array; kind: 'shape' | 'graphic'; colorStd: number }[] = [];
  const px = new Uint8Array(rgb.data); // copy: allocations below may detach heap views
  for (const c of cands.slice(0, p.max ?? 6)) {
    const m = cv.Mat.zeros(ah, aw, cv.CV_8UC1);
    cv.drawContours(m, contours, c.idx, new cv.Scalar(255), -1);
    erode(m, 3, 1); // edge dilation made it fat
    const md = m.data as Uint8Array;
    let cnt = 0;
    const sum = [0, 0, 0], sq = [0, 0, 0];
    for (let i = 0; i < n; i++) if (md[i]) {
      cnt++;
      for (let k = 0; k < 3; k++) { const v = px[i * 3 + k]; sum[k] += v; sq[k] += v * v; }
    }
    if (!cnt) { m.delete(); continue; }
    const std = Math.sqrt(sq.reduce((acc, q, k) => acc + q / cnt - (sum[k] / cnt) ** 2, 0) / 3);
    const mf = upsampleMask(m, W, H);
    m.delete();
    const box = fullBox({ x0: c.r.x, y0: c.r.y, x1: c.r.x + c.r.width - 1, y1: c.r.y + c.r.height - 1 }, s, W, H);
    out.push({ box, mask: cropMask(mf, W, box), kind: std < 22 ? 'shape' : 'graphic', colorStd: std });
  }
  contours.delete(); rgb.delete();
  return out;
}

// ---------------------------------------------------------------- inpainting
/**
 * Two-scale background reconstruction:
 *  - large object holes are filled at reduced resolution (fast, smooth) and blended in;
 *  - thin text holes are filled at full resolution box by box (keeps edges crisp,
 *    avoids "ghost letters" caused by down-sampling).
 */
function inpaint(p: { rgba: ArrayBuffer; w: number; h: number; mask: ArrayBuffer; textMask?: ArrayBuffer; textBoxes?: Box[]; maxSide?: number }) {
  const { w: W, h: H } = p;
  const maskArr = new Uint8Array(p.mask);
  let area = 0;
  for (let i = 0; i < maskArr.length; i++) if (maskArr[i]) area++;
  const o = new Uint8ClampedArray(p.rgba);
  let method = 'none';
  if (area > 0) {
    const big = area / maskArr.length > 0.12;
    const { aw, ah } = analysisSize(W, H, p.maxSide ?? (big ? 560 : 800));
    const full = rgbaMat(p.rgba, W, H);
    const small = resized(full, aw, ah, cv.INTER_AREA);
    full.delete();
    const rgb = rgbOf(small);
    small.delete();
    const mFull = grayMat(maskArr, W, H);
    const mSmall = resized(mFull, aw, ah, cv.INTER_AREA);
    cv.threshold(mSmall, mSmall, 0, 255, cv.THRESH_BINARY);
    dilate(mSmall, 3, 2);
    const filled = new cv.Mat();
    if (typeof cv.inpaint === 'function') {
      cv.inpaint(rgb, mSmall, filled, 5, cv.INPAINT_TELEA);
      method = 'TELEA';
    } else {
      method = 'diffusion (fallback)';
      rgb.copyTo(filled);
      diffuse(filled.data as Uint8Array, mSmall.data as Uint8Array, aw, ah, 3);
    }
    rgb.delete(); mSmall.delete();
    const up = resized(filled, W, H, cv.INTER_CUBIC);
    filled.delete();
    dilate(mFull, 3, 2);
    const soft = new cv.Mat();
    cv.GaussianBlur(mFull, soft, new cv.Size(7, 7), 0);
    mFull.delete();
    const ud = up.data as Uint8Array, sd = soft.data as Uint8Array;
    for (let i = 0; i < W * H; i++) {
      const a = sd[i] / 255;
      if (!a) continue;
      for (let k = 0; k < 3; k++) o[i * 4 + k] = o[i * 4 + k] * (1 - a) + ud[i * 3 + k] * a;
      o[i * 4 + 3] = 255;
    }
    up.delete(); soft.delete();
  }
  if (p.textMask && p.textBoxes?.length && typeof cv.inpaint === 'function') {
    const tm = new Uint8Array(p.textMask);
    for (const b0 of p.textBoxes) {
      const pad = 10;
      const x = Math.max(0, b0.x - pad), y = Math.max(0, b0.y - pad);
      const bw = Math.min(W, b0.x + b0.w + pad) - x, bh = Math.min(H, b0.y + b0.h + pad) - y;
      if (bw < 3 || bh < 3) continue;
      const crop = new cv.Mat(bh, bw, cv.CV_8UC3);
      const m = new cv.Mat(bh, bw, cv.CV_8UC1);
      const cd = crop.data as Uint8Array, md = m.data as Uint8Array;
      let any = false;
      for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) {
        const si = (y + yy) * W + (x + xx), di = yy * bw + xx;
        cd[di * 3] = o[si * 4]; cd[di * 3 + 1] = o[si * 4 + 1]; cd[di * 3 + 2] = o[si * 4 + 2];
        md[di] = tm[si] > 40 ? 255 : 0;
        if (md[di]) any = true;
      }
      if (any) {
        dilate(m, 7, 1);
        const out = new cv.Mat();
        cv.inpaint(crop, m, out, 3, cv.INPAINT_TELEA);
        const od = out.data as Uint8Array, md2 = m.data as Uint8Array;
        for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) {
          const di = yy * bw + xx;
          if (!md2[di]) continue;
          const si = (y + yy) * W + (x + xx);
          o[si * 4] = od[di * 3]; o[si * 4 + 1] = od[di * 3 + 1]; o[si * 4 + 2] = od[di * 3 + 2];
        }
        out.delete();
      }
      crop.delete(); m.delete();
    }
    method = method === 'none' ? 'TELEA (text)' : method + ' + full-res text';
  }
  return { rgba: o.buffer, method };
}

/** Fallback hole filling: iterative neighbour averaging, onion-peel from the edge. */
function diffuse(px: Uint8Array, mask: Uint8Array, w: number, h: number, ch: number) {
  const known = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) known[i] = mask[i] ? 0 : 1;
  for (let pass = 0; pass < Math.max(w, h); pass++) {
    const newly: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (known[i]) continue;
      const acc = [0, 0, 0];
      let c = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!known[j]) continue;
        for (let k = 0; k < ch; k++) acc[k] += px[j * ch + k];
        c++;
      }
      if (c) { for (let k = 0; k < ch; k++) px[i * ch + k] = acc[k] / c; newly.push(i); }
    }
    if (!newly.length) break;
    for (const i of newly) known[i] = 1;
  }
}

// ---------------------------------------------------------------- refine a rough user mask
function refine(p: { rgba: ArrayBuffer; w: number; h: number; mask: ArrayBuffer; iterations?: number }) {
  const { w: W, h: H } = p;
  const { aw, ah } = analysisSize(W, H, 720);
  const full = rgbaMat(p.rgba, W, H);
  const small = resized(full, aw, ah, cv.INTER_AREA);
  full.delete();
  const rgb = rgbOf(small);
  small.delete();
  const m = grayMat(new Uint8Array(p.mask), W, H);
  const ms = resized(m, aw, ah, cv.INTER_AREA);
  m.delete();
  cv.threshold(ms, ms, 127, 255, cv.THRESH_BINARY);
  const inner = ms.clone();
  const outer = ms.clone();
  const r = Math.max(2, Math.round(Math.min(aw, ah) * 0.012));
  erode(inner, 3, r);
  dilate(outer, 3, r * 2);
  const labels = new cv.Mat(ah, aw, cv.CV_8UC1);
  let ld = labels.data as Uint8Array;
  const sd = ms.data as Uint8Array, id = inner.data as Uint8Array, od = outer.data as Uint8Array;
  let fgCount = 0;
  for (let i = 0; i < aw * ah; i++) {
    ld[i] = id[i] ? GC_FGD : sd[i] ? GC_PR_FGD : od[i] ? GC_PR_BGD : GC_BGD;
    if (sd[i]) fgCount++;
  }
  ms.delete(); inner.delete(); outer.delete();
  if (!fgCount) { labels.delete(); rgb.delete(); throw new Error('Selection is empty.'); }
  const bgd = new cv.Mat(), fgd = new cv.Mat();
  cv.grabCut(rgb, labels, new cv.Rect(0, 0, 1, 1), bgd, fgd, p.iterations ?? 4, cv.GC_INIT_WITH_MASK);
  bgd.delete(); fgd.delete(); rgb.delete();
  ld = labels.data as Uint8Array; // re-fetch: the heap may have grown
  for (let i = 0; i < aw * ah; i++) ld[i] = ld[i] === GC_FGD || ld[i] === GC_PR_FGD ? 255 : 0;
  morph(labels, cv.MORPH_OPEN, 3);
  const out = upsampleMask(labels, W, H);
  labels.delete();
  return { mask: out.buffer };
}

// ---------------------------------------------------------------- dispatcher
scope.onmessage = async (e: MessageEvent) => {
  const { id, op, payload } = e.data as { id: number; op: string; payload: unknown };
  try {
    if (op !== 'init' && !cv) throw new Error('OpenCV is not loaded yet.');
    let result: unknown;
    const transfer: Transferable[] = [];
    switch (op) {
      case 'init':
        result = await init((payload as { baseUrl: string }).baseUrl);
        break;
      case 'foreground': {
        const r = foreground(payload as FgParams);
        if (r.main) transfer.push(r.main.mask.buffer);
        r.secondary?.forEach((s) => transfer.push(s.mask.buffer));
        result = r;
        break;
      }
      case 'graphics': {
        const r = graphics(payload as Parameters<typeof graphics>[0]);
        r.forEach((g) => transfer.push(g.mask.buffer));
        result = r;
        break;
      }
      case 'inpaint': {
        const r = inpaint(payload as Parameters<typeof inpaint>[0]);
        transfer.push(r.rgba);
        result = r;
        break;
      }
      case 'refine': {
        const r = refine(payload as Parameters<typeof refine>[0]);
        transfer.push(r.mask);
        result = r;
        break;
      }
      default:
        throw new Error('Unknown op ' + op);
    }
    scope.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    const msg = typeof err === 'number' && cv?.exceptionFromPtr ? cv.exceptionFromPtr(err).msg : (err as Error)?.message ?? String(err);
    scope.postMessage({ id, ok: false, error: msg });
  }
};
