import { cvForeground, cvGraphics, cvInpaint, loadOpenCV, placeMask } from './cvClient';
import { cutout, imageDataToCanvas, imageDataToUrl, uid, urlToImageData } from './image';
import { onOcrProgress, recognizeLines, type OcrLine } from './ocr';
import { estimateFontSize, textPixels } from './textMask';
import type { Box, Confidence, Decomposition, LayerSpec, SourceImage, StepState } from './types';

export const DECOMPOSE_STEPS: StepState[] = [
  { key: 'prepare', label: 'Prepare image', status: 'pending' },
  { key: 'opencv', label: 'Load OpenCV.js (computer vision engine)', status: 'pending' },
  { key: 'ocr', label: 'Detect & read text (Tesseract OCR)', status: 'pending' },
  { key: 'foreground', label: 'Separate foreground objects (GrabCut + watershed)', status: 'pending' },
  { key: 'graphics', label: 'Find graphics & shapes (edges + contours)', status: 'pending' },
  { key: 'background', label: 'Reconstruct background (inpainting)', status: 'pending' },
  { key: 'layers', label: 'Build transparent layers', status: 'pending' },
];

type StepPatch = Partial<StepState>;
export type StepFn = (key: string, patch: StepPatch) => void;

class Cancelled extends Error {}

export async function decompose(src: SourceImage, onStep: StepFn, signal: { cancelled: boolean }): Promise<Decomposition> {
  const log: string[] = [];
  const check = () => {
    if (signal.cancelled) throw new Cancelled('Cancelled');
  };
  const step = async <T,>(key: string, fn: () => Promise<T>, optional = false): Promise<T | null> => {
    check();
    onStep(key, { status: 'running', detail: undefined, progress: undefined });
    const t0 = performance.now();
    try {
      const r = await fn();
      check();
      onStep(key, { status: 'done', progress: 1, detail: `${((performance.now() - t0) / 1000).toFixed(1)} s` });
      return r;
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      const msg = (e as Error).message || String(e);
      log.push(`${key} failed: ${msg}`);
      onStep(key, { status: optional ? 'skipped' : 'failed', detail: msg });
      if (!optional) throw e;
      return null;
    }
  };

  // 1. prepare
  const img = (await step('prepare', () => urlToImageData(src.url)))!;
  const W = img.width, H = img.height;

  // 2. OpenCV
  await step('opencv', async () => {
    const r = await loadOpenCV();
    log.push(`OpenCV.js loaded (${r.source}).`);
  });

  // 3. OCR (optional: a failure here still lets the user continue)
  interface TextItem extends OcrLine { pixels: ReturnType<typeof textPixels>; onObject: boolean; parent?: string }
  const texts: TextItem[] = [];
  await step(
    'ocr',
    async () => {
      onOcrProgress((p, status) => onStep('ocr', { progress: p, detail: status }));
      const lines = await recognizeLines(imageDataToCanvas(img));
      onOcrProgress(null);
      for (const l of lines.slice(0, 24)) texts.push({ ...l, pixels: textPixels(img, l.box), onObject: false });
      log.push(`OCR found ${texts.length} text line(s).`);
    },
    true,
  );
  onOcrProgress(null);

  const glyphFull = new Uint8Array(W * H);
  for (const t of texts) placeMask(glyphFull, W, t.pixels.box, t.pixels.mask);

  // 4. foreground
  const fg = (await step('foreground', () => cvForeground(img, texts.map((t) => t.box), glyphFull)))!;
  log.push(...fg.log);
  fg.onObject.forEach((on, i) => (texts[i].onObject = on));

  const ids = { main: uid('subject'), secondary: (fg.secondary ?? []).map(() => uid('object')) };

  // 4b. second OCR pass inside small objects (buttons, badges, price tags)
  if (texts.length < 24 && fg.secondary?.length) {
    try {
      const canvas = imageDataToCanvas(img);
      for (const [i, s] of fg.secondary.entries()) {
        if (s.box.w * s.box.h > W * H * 0.15) continue;
        const extra = await recognizeLines(canvas, { rect: s.box, sparse: true, minConfidence: 60 });
        for (const l of extra) {
          if (texts.some((t) => overlap(t.box, l.box) > 0.3)) continue;
          texts.push({ ...l, pixels: textPixels(img, l.box), onObject: true, parent: ids.secondary[i] });
        }
      }
    } catch (e) {
      log.push('Second OCR pass skipped: ' + (e as Error).message);
    }
  }
  // text that sits on the main subject belongs to it
  if (fg.main) for (const t of texts) if (t.onObject && !t.parent && contains(fg.main.box, t.box)) t.parent = ids.main;

  // 5. graphics & shapes
  const exclude = new Uint8Array(W * H);
  if (fg.main) placeMask(exclude, W, fg.main.box, fg.main.mask);
  fg.secondary?.forEach((s) => placeMask(exclude, W, s.box, s.mask));
  for (const t of texts) fillBox(exclude, W, H, t.pixels.box);
  const graphics = (await step('graphics', () => cvGraphics(img, exclude), true)) ?? [];
  log.push(`Graphics/shapes found: ${graphics.length}.`);

  // 6. background reconstruction
  const hole = new Uint8Array(W * H);
  if (fg.main) placeMask(hole, W, fg.main.box, fg.main.mask);
  fg.secondary?.forEach((s) => placeMask(hole, W, s.box, s.mask));
  graphics.forEach((g) => placeMask(hole, W, g.box, g.mask));
  const textHole = new Uint8Array(W * H);
  const freeTexts = texts.filter((t) => !t.onObject);
  for (const t of freeTexts) placeMask(textHole, W, t.pixels.box, t.pixels.mask);
  let holeArea = 0;
  for (let i = 0; i < hole.length; i++) if (hole[i] > 127 || textHole[i] > 127) holeArea++;
  const holeRatio = holeArea / (W * H);
  let bgData: ImageData = img;
  let bgMethod = 'none';
  const bgRes = await step(
    'background',
    async () => {
      if (holeArea === 0) return null;
      return cvInpaint(img, hole, { mask: textHole, boxes: freeTexts.map((t) => t.pixels.box) });
    },
    true,
  );
  if (bgRes) {
    bgData = bgRes.data;
    bgMethod = bgRes.method;
  }
  log.push(`Background: ${(holeRatio * 100).toFixed(1)}% of pixels reconstructed (${bgMethod}).`);

  // 7. layers (bottom -> top)
  const layers: LayerSpec[] = [];
  await step('layers', async () => {
    layers.push({
      id: uid('original'), name: 'Original image (reference)', kind: 'original', confidence: 'high',
      box: { x: 0, y: 0, w: W, h: H }, url: src.url, include: true, visible: false,
      note: 'Untouched upload, hidden by default. Useful to compare against.',
    });
    const bgConf: Confidence = !bgRes && holeArea ? 'manual' : holeRatio < 0.08 ? 'high' : holeRatio < 0.25 ? 'medium' : 'manual';
    layers.push({
      id: uid('bg'), name: 'Background (reconstructed)', kind: 'background', confidence: bgConf,
      box: { x: 0, y: 0, w: W, h: H }, url: holeArea && bgRes ? await imageDataToUrl(bgData) : src.url, include: true, visible: true,
      note: bgRes
        ? `${(holeRatio * 100).toFixed(0)}% of the area behind removed objects was filled by inpainting. Large fills look smeared — replace with a colour or image if needed.`
        : 'No reconstruction was possible; this is the original image.',
    });
    for (const [i, g] of graphics.entries()) {
      const c = await cutout(img, toFull(g.mask, g.box, W, H));
      if (!c) continue;
      layers.push({
        id: uid(g.kind), name: g.kind === 'shape' ? `Shape ${i + 1}` : `Graphic / logo ${i + 1}`, kind: g.kind,
        confidence: 'medium', box: c.box, url: c.url, include: true, visible: true, coverage: c.coverage,
        note: 'Found from edges and contours. Check the outline; refine the mask if needed.',
      });
    }
    for (const [i, s] of (fg.secondary ?? []).entries()) {
      const c = await cutout(img, toFull(s.mask, s.box, W, H));
      if (!c) continue;
      layers.push({
        id: ids.secondary[i], name: `Object ${i + 1}`, kind: 'object', confidence: s.areaRatio > 0.02 ? 'medium' : 'manual',
        box: c.box, url: c.url, include: true, visible: true, coverage: c.coverage,
        note: 'Secondary foreground region (often a button, badge or product detail).',
      });
    }
    if (fg.main) {
      const c = await cutout(img, toFull(fg.main.mask, fg.main.box, W, H));
      if (c)
        layers.push({
          id: ids.main, name: 'Main subject', kind: 'subject', confidence: fg.main.confidence, box: c.box, url: c.url,
          include: true, visible: true, coverage: c.coverage,
          note:
            fg.main.confidence === 'high'
              ? 'Clean separation from the background.'
              : 'Separation is uncertain — use “Refine mask” in the studio to correct it.',
        });
    }
    for (const t of texts) {
      const c = await cutout(img, toFull(t.pixels.mask, t.pixels.box, W, H));
      if (!c) continue;
      const conf: Confidence = t.confidence >= 85 && t.pixels.contrast > 80 ? 'high' : t.confidence >= 65 && t.pixels.contrast > 40 ? 'medium' : 'manual';
      layers.push({
        id: uid('text'), name: `Text: ${t.text.slice(0, 28)}`, kind: 'text', confidence: conf, box: c.box, url: c.url,
        include: true, visible: true, text: t.text, textColor: t.pixels.textColor,
        fontSize: estimateFontSize(t.text, t.box.h), onObject: t.onObject, coverage: c.coverage,
        note: `OCR ${t.confidence.toFixed(0)}% sure. Original pixels are kept as an image; convert to editable text to change wording.` +
          (t.onObject ? ' Sits on an object — converting repaints the object behind it with its local colour.' : ''),
        ...(t.parent ? { parentId: t.parent, parentBg: t.pixels.bgColor } : {}),
      });
    }
  });
  if (!fg.found) log.push('No foreground object was found automatically — use manual selection in the studio.');
  return { docW: W, docH: H, layers, log };
}

function toFull(crop: Uint8Array, box: Box, W: number, H: number): Uint8Array {
  const full = new Uint8Array(W * H);
  placeMask(full, W, box, crop);
  return full;
}
function fillBox(m: Uint8Array, W: number, H: number, b: Box) {
  for (let y = Math.max(0, b.y); y < Math.min(H, b.y + b.h); y++) m.fill(255, y * W + Math.max(0, b.x), y * W + Math.min(W, b.x + b.w));
}
function overlap(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (x * y) / Math.min(a.w * a.h, b.w * b.h);
}
function contains(outer: Box, inner: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/** Minimal "decomposition" for manual mode: just the image as one layer. */
export function singleLayer(src: SourceImage): Decomposition {
  return {
    docW: src.width,
    docH: src.height,
    log: ['Manual mode: automatic decomposition skipped.'],
    layers: [
      {
        id: uid('image'), name: 'Image', kind: 'image', confidence: 'manual', box: { x: 0, y: 0, w: src.width, h: src.height },
        url: src.url, include: true, visible: true, note: 'Use the selection tools to extract objects manually.',
      },
    ],
  };
}
