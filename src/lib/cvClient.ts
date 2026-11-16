import type { Box } from './types';

/* Promise-based client for the OpenCV worker. */

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let ready: Promise<{ source: string }> | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function spawn(): Worker {
  const w = new Worker(new URL('../workers/cv.worker.ts', import.meta.url));
  w.onmessage = (e: MessageEvent) => {
    const { id, ok, result, error } = e.data as { id: number; ok: boolean; result?: unknown; error?: string };
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(result);
    else p.reject(new Error(error || 'OpenCV operation failed'));
  };
  w.onerror = (e) => {
    const err = new Error(e.message || 'OpenCV worker crashed (possibly out of memory).');
    pending.forEach((p) => p.reject(err));
    pending.clear();
    worker = null;
    ready = null;
  };
  return w;
}

function call<T>(op: string, payload: unknown, transfer: Transferable[] = []): Promise<T> {
  if (!worker) worker = spawn();
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ id, op, payload }, transfer);
  });
}

/** Loads OpenCV.js inside the worker (once). */
export function loadOpenCV(): Promise<{ source: string }> {
  if (!ready) {
    const baseUrl = new URL(import.meta.env.BASE_URL, document.baseURI).href;
    ready = call<{ source: string }>('init', { baseUrl }).catch((e) => {
      ready = null;
      worker?.terminate();
      worker = null;
      throw e;
    });
  }
  return ready;
}

export function resetOpenCV() {
  worker?.terminate();
  worker = null;
  ready = null;
  pending.forEach((p) => p.reject(new Error('Cancelled')));
  pending.clear();
}

const copyBuf = (d: ImageData) => d.data.slice().buffer;

export interface FgResult {
  found: boolean;
  log: string[];
  onObject: boolean[];
  main?: { box: Box; mask: Uint8Array; confidence: 'high' | 'medium' | 'manual'; areaRatio: number; borderTouch: number };
  secondary?: { box: Box; mask: Uint8Array; areaRatio: number }[];
}

export async function cvForeground(img: ImageData, textBoxes: Box[], glyph?: Uint8Array, rect?: Box, maxSecondary = 5): Promise<FgResult> {
  await loadOpenCV();
  const rgba = copyBuf(img);
  const g = glyph ? glyph.slice().buffer : undefined;
  return call<FgResult>(
    'foreground',
    { rgba, w: img.width, h: img.height, textBoxes, glyph: g, rect, maxSecondary },
    g ? [rgba, g] : [rgba],
  );
}

export async function cvGraphics(img: ImageData, exclude: Uint8Array, max = 6) {
  await loadOpenCV();
  const rgba = copyBuf(img);
  const ex = exclude.slice().buffer;
  return call<{ box: Box; mask: Uint8Array; kind: 'shape' | 'graphic'; colorStd: number }[]>(
    'graphics',
    { rgba, w: img.width, h: img.height, exclude: ex, max },
    [rgba, ex],
  );
}

export async function cvInpaint(
  img: ImageData, mask: Uint8Array, text?: { mask: Uint8Array; boxes: Box[] },
): Promise<{ data: ImageData; method: string }> {
  await loadOpenCV();
  const rgba = copyBuf(img);
  const m = mask.slice().buffer;
  const tm = text ? text.mask.slice().buffer : undefined;
  const r = await call<{ rgba: ArrayBuffer; method: string }>(
    'inpaint',
    { rgba, w: img.width, h: img.height, mask: m, textMask: tm, textBoxes: text?.boxes },
    tm ? [rgba, m, tm] : [rgba, m],
  );
  return { data: new ImageData(new Uint8ClampedArray(r.rgba), img.width, img.height), method: r.method };
}

/** Snap a rough user selection to object edges with mask-initialised GrabCut. */
export async function cvRefine(img: ImageData, mask: Uint8Array): Promise<Uint8Array> {
  await loadOpenCV();
  const rgba = copyBuf(img);
  const m = mask.slice().buffer;
  const r = await call<{ mask: ArrayBuffer }>('refine', { rgba, w: img.width, h: img.height, mask: m }, [rgba, m]);
  return new Uint8Array(r.mask);
}

/** Paste a cropped mask back into a full-size mask. */
export function placeMask(full: Uint8Array, W: number, box: Box, crop: Uint8Array) {
  for (let y = 0; y < box.h; y++) {
    const row = (box.y + y) * W + box.x;
    for (let x = 0; x < box.w; x++) {
      const v = crop[y * box.w + x];
      if (v > full[row + x]) full[row + x] = v;
    }
  }
}
