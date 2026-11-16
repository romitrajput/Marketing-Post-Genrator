import { createWorker, PSM, type Worker as TWorker } from 'tesseract.js';
import type { Box } from './types';

export interface OcrLine {
  text: string;
  confidence: number; // 0..100
  box: Box;
}

let workerPromise: Promise<{ worker: TWorker; source: string }> | null = null;
let progressCb: ((p: number, status: string) => void) | null = null;

async function localAssetsAvailable(base: string): Promise<{ worker: boolean; lang: boolean }> {
  const head = async (u: string) => {
    try {
      const r = await fetch(u, { method: 'HEAD' });
      return r.ok && !(r.headers.get('content-type') || '').includes('text/html');
    } catch {
      return false;
    }
  };
  const [worker, lang] = await Promise.all([head(base + 'tesseract/worker.min.js'), head(base + 'tesseract/lang/eng.traineddata.gz')]);
  return { worker, lang };
}

/** Lazily creates one Tesseract worker. Prefers self-hosted files, falls back to jsDelivr. */
export function getOcr(): Promise<{ worker: TWorker; source: string }> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const base = new URL(import.meta.env.BASE_URL, document.baseURI).href;
      const local = await localAssetsAvailable(base);
      const opts: Record<string, unknown> = {
        logger: (m: { status: string; progress: number }) => progressCb?.(m.progress ?? 0, m.status ?? ''),
      };
      if (local.worker) {
        opts.workerPath = base + 'tesseract/worker.min.js';
        opts.corePath = base + 'tesseract/core';
      }
      if (local.lang) opts.langPath = base + 'tesseract/lang';
      const worker = await createWorker('eng', 1, opts);
      const source = `engine: ${local.worker ? 'self-hosted' : 'jsDelivr CDN'}, language data: ${local.lang ? 'self-hosted' : 'CDN (cached after first use)'}`;
      return { worker, source };
    })().catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

export function onOcrProgress(cb: ((p: number, status: string) => void) | null) {
  progressCb = cb;
}

interface TLine {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectLines(data: any): TLine[] {
  if (Array.isArray(data?.lines) && data.lines.length) return data.lines;
  const out: TLine[] = [];
  for (const b of data?.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) out.push(l);
  return out;
}

function cleanText(t: string): string {
  return t.replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}@#₹$%&(]+|[^\p{L}\p{N}%!?.)₹$]+$/gu, '').trim();
}

/**
 * Recognise text lines in an image (canvas or URL). `rect` limits recognition to a region,
 * `sparse` uses Tesseract's sparse-text mode (better for buttons and badges).
 */
export async function recognizeLines(
  image: HTMLCanvasElement | string,
  opts: { rect?: Box; sparse?: boolean; minConfidence?: number } = {},
): Promise<OcrLine[]> {
  const { worker } = await getOcr();
  await worker.setParameters({ tessedit_pageseg_mode: opts.sparse ? PSM.SPARSE_TEXT : PSM.AUTO });
  const rectangle = opts.rect ? { left: opts.rect.x, top: opts.rect.y, width: opts.rect.w, height: opts.rect.h } : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await (worker as any).recognize(image, rectangle ? { rectangle } : {}, { text: true, blocks: true });
  const min = opts.minConfidence ?? 55;
  const lines: OcrLine[] = [];
  for (const l of collectLines(res.data)) {
    const text = cleanText(l.text ?? '');
    if (text.replace(/\s/g, '').length < 2 || (l.confidence ?? 0) < min) continue;
    const { x0, y0, x1, y1 } = l.bbox;
    if (x1 - x0 < 4 || y1 - y0 < 4) continue;
    lines.push({ text, confidence: l.confidence, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  }
  return lines;
}
