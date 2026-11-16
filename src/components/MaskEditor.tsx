import { useCallback, useEffect, useRef, useState } from 'react';
import { cvForeground, cvRefine, placeMask } from '../lib/cvClient';
import { createCanvas, ctx2d, imageDataToCanvas, urlToImageData } from '../lib/image';
import { Button, ErrorBox, Modal, Slider, Spinner } from './ui';

type Tool = 'rect' | 'poly' | 'brush' | 'erase' | 'hand';

export interface MaskResult {
  mask: Uint8Array;
  width: number;
  height: number;
  option: boolean;
  source: ImageData;
}

interface Props {
  title: string;
  sourceUrl: string;
  initialMask?: Uint8Array | null;
  autoDetect?: boolean;
  applyLabel: string;
  option?: { label: string; initial: boolean };
  hint?: string;
  onCancel: () => void;
  onApply: (r: MaskResult) => Promise<void> | void;
}

const UNDO_LIMIT = 8;

/**
 * Manual selection tool: rectangle, polygon, brush, eraser, invert, auto-detect
 * (GrabCut) and edge refinement. Works at the source image's own resolution.
 */
export default function MaskEditor(p: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const src = useRef<{ data: ImageData; canvas: HTMLCanvasElement } | null>(null);
  const mask = useRef<HTMLCanvasElement | null>(null);
  const tint = useRef<HTMLCanvasElement | null>(null);
  const tintDirty = useRef(true);
  const view = useRef({ k: 1, ox: 0, oy: 0 });
  const undo = useRef<Uint8Array[]>([]);
  const poly = useRef<{ x: number; y: number }[]>([]);
  const drag = useRef<{ x0: number; y0: number; x: number; y: number; px?: number; py?: number } | null>(null);
  const cursor = useRef<{ x: number; y: number } | null>(null);

  const [tool, setTool] = useState<Tool>('brush');
  const [subtract, setSubtract] = useState(false);
  const [brush, setBrush] = useState(40);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState<string | null>('Loading image…');
  const [err, setErr] = useState<string | null>(null);
  const [option, setOption] = useState(p.option?.initial ?? false);
  const [, setTick] = useState(0);
  const [empty, setEmpty] = useState(true);

  // ---------------------------------------------------------------- mask io
  const readAlpha = useCallback((): Uint8Array => {
    const m = mask.current!;
    const d = ctx2d(m).getImageData(0, 0, m.width, m.height).data;
    const a = new Uint8Array(m.width * m.height);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    return a;
  }, []);
  const writeAlpha = useCallback((a: Uint8Array) => {
    const m = mask.current!;
    const img = new ImageData(m.width, m.height);
    for (let i = 0; i < a.length; i++) {
      const j = i * 4;
      img.data[j] = img.data[j + 1] = img.data[j + 2] = 255;
      img.data[j + 3] = a[i];
    }
    ctx2d(m).putImageData(img, 0, 0);
    tintDirty.current = true;
  }, []);
  const pushUndo = useCallback(() => {
    undo.current.push(readAlpha());
    if (undo.current.length > UNDO_LIMIT) undo.current.shift();
    setTick((t) => t + 1);
  }, [readAlpha]);
  const updateEmpty = useCallback(() => {
    const a = readAlpha();
    let any = false;
    for (let i = 0; i < a.length; i += 7) if (a[i] > 127) { any = true; break; }
    setEmpty(!any);
  }, [readAlpha]);

  // ---------------------------------------------------------------- rendering
  const render = useCallback(() => {
    const cv = viewRef.current, s = src.current, m = mask.current;
    if (!cv || !s || !m) return;
    const ctx = ctx2d(cv);
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const { k, ox, oy } = view.current;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
    const W = s.data.width, H = s.data.height;
    // checkerboard
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#e7e5e4';
    const cs = 12 / k;
    for (let y = 0; y < H; y += cs) for (let x = (Math.floor(y / cs) % 2) * cs; x < W; x += cs * 2) ctx.fillRect(x, y, Math.min(cs, W - x), Math.min(cs, H - y));
    if (preview) {
      const t = createCanvas(W, H);
      const tc = ctx2d(t);
      tc.drawImage(s.canvas, 0, 0);
      tc.globalCompositeOperation = 'destination-in';
      tc.drawImage(m, 0, 0);
      ctx.drawImage(t, 0, 0);
    } else {
      ctx.drawImage(s.canvas, 0, 0);
      if (tintDirty.current || !tint.current) {
        const t = tint.current ?? createCanvas(W, H);
        const tc = ctx2d(t);
        tc.globalCompositeOperation = 'source-over';
        tc.clearRect(0, 0, W, H);
        tc.fillStyle = '#ef4444';
        tc.fillRect(0, 0, W, H);
        tc.globalCompositeOperation = 'destination-in';
        tc.drawImage(m, 0, 0);
        tint.current = t;
        tintDirty.current = false;
      }
      ctx.globalAlpha = 0.45;
      ctx.drawImage(tint.current, 0, 0);
      ctx.globalAlpha = 1;
    }
    // in-progress shapes
    ctx.lineWidth = 2 / k;
    ctx.strokeStyle = subtract ? '#0ea5e9' : '#111827';
    ctx.setLineDash([6 / k, 4 / k]);
    const d = drag.current;
    if (d && tool === 'rect') ctx.strokeRect(Math.min(d.x0, d.x), Math.min(d.y0, d.y), Math.abs(d.x - d.x0), Math.abs(d.y - d.y0));
    if (tool === 'poly' && poly.current.length) {
      ctx.beginPath();
      poly.current.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      if (cursor.current) ctx.lineTo(cursor.current.x, cursor.current.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#111827';
      poly.current.forEach((q, i) => {
        ctx.beginPath();
        ctx.arc(q.x, q.y, (i === 0 ? 6 : 4) / k, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    ctx.setLineDash([]);
    if ((tool === 'brush' || tool === 'erase') && cursor.current) {
      ctx.beginPath();
      ctx.arc(cursor.current.x, cursor.current.y, brush / 2, 0, Math.PI * 2);
      ctx.strokeStyle = tool === 'erase' ? '#0ea5e9' : '#111827';
      ctx.stroke();
    }
  }, [preview, tool, subtract, brush]);

  const fit = useCallback(() => {
    const host = hostRef.current, cv = viewRef.current, s = src.current;
    if (!host || !cv || !s) return;
    const r = host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(r.height * dpr);
    cv.style.width = r.width + 'px';
    cv.style.height = r.height + 'px';
    const k = Math.min((r.width - 24) / s.data.width, (r.height - 24) / s.data.height);
    view.current = { k, ox: (r.width - s.data.width * k) / 2, oy: (r.height - s.data.height * k) / 2 };
    render();
  }, [render]);

  // ---------------------------------------------------------------- load
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await urlToImageData(p.sourceUrl);
        if (!alive) return;
        src.current = { data, canvas: imageDataToCanvas(data) };
        mask.current = createCanvas(data.width, data.height);
        if (p.initialMask && p.initialMask.length === data.width * data.height) writeAlpha(p.initialMask);
        setBusy(null);
        fit();
        updateEmpty();
        if (p.autoDetect && !p.initialMask) await autoDetect();
      } catch (e) {
        if (alive) {
          setBusy(null);
          setErr((e as Error).message);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.sourceUrl]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(host);
    return () => ro.disconnect();
  }, [fit]);
  useEffect(() => render(), [render]);

  // ---------------------------------------------------------------- operations
  const autoDetect = async () => {
    if (!src.current) return;
    setBusy('Detecting the main object (GrabCut)…');
    setErr(null);
    try {
      const r = await cvForeground(src.current.data, [], undefined, undefined, 0);
      if (!r.main) throw new Error('No object found automatically. Draw a rough selection, then use “Snap to edges”.');
      pushUndo();
      const full = new Uint8Array(src.current.data.width * src.current.data.height);
      placeMask(full, src.current.data.width, r.main.box, r.main.mask);
      writeAlpha(full);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      updateEmpty();
      render();
    }
  };
  const snap = async () => {
    if (!src.current) return;
    setBusy('Snapping selection to edges (GrabCut)…');
    setErr(null);
    try {
      const before = readAlpha();
      const out = await cvRefine(src.current.data, before);
      pushUndo();
      writeAlpha(out);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      updateEmpty();
      render();
    }
  };
  const invert = () => {
    pushUndo();
    const a = readAlpha();
    for (let i = 0; i < a.length; i++) a[i] = 255 - a[i];
    writeAlpha(a);
    updateEmpty();
    render();
  };
  const fill = (v: number) => {
    pushUndo();
    writeAlpha(new Uint8Array(mask.current!.width * mask.current!.height).fill(v));
    updateEmpty();
    render();
  };
  const doUndo = () => {
    const a = undo.current.pop();
    if (!a) return;
    writeAlpha(a);
    updateEmpty();
    setTick((t) => t + 1);
    render();
  };
  const closePoly = () => {
    const pts = poly.current;
    if (pts.length >= 3) {
      pushUndo();
      const c = ctx2d(mask.current!);
      c.globalCompositeOperation = subtract ? 'destination-out' : 'source-over';
      c.fillStyle = '#fff';
      c.beginPath();
      pts.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));
      c.closePath();
      c.fill();
      c.globalCompositeOperation = 'source-over';
      tintDirty.current = true;
      updateEmpty();
    }
    poly.current = [];
    render();
  };

  // ---------------------------------------------------------------- pointer
  const toImg = (e: React.PointerEvent | React.WheelEvent | React.MouseEvent) => {
    const r = viewRef.current!.getBoundingClientRect();
    const { k, ox, oy } = view.current;
    return { x: (e.clientX - r.left - ox) / k, y: (e.clientY - r.top - oy) / k, sx: e.clientX - r.left, sy: e.clientY - r.top };
  };
  const stroke = (x0: number, y0: number, x1: number, y1: number) => {
    const c = ctx2d(mask.current!);
    c.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over';
    c.strokeStyle = '#fff';
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = brush;
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1 + 0.01, y1);
    c.stroke();
    c.globalCompositeOperation = 'source-over';
    tintDirty.current = true;
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (busy || !src.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const q = toImg(e);
    if (tool === 'hand' || e.button === 1) {
      drag.current = { x0: q.sx, y0: q.sy, x: q.sx, y: q.sy, px: view.current.ox, py: view.current.oy };
      return;
    }
    if (tool === 'poly') {
      const first = poly.current[0];
      if (first && Math.hypot(first.x - q.x, first.y - q.y) * view.current.k < 12) closePoly();
      else poly.current.push({ x: q.x, y: q.y });
      render();
      return;
    }
    if (preview) setPreview(false);
    pushUndo();
    drag.current = { x0: q.x, y0: q.y, x: q.x, y: q.y };
    if (tool === 'brush' || tool === 'erase') stroke(q.x, q.y, q.x, q.y);
    render();
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const q = toImg(e);
    cursor.current = { x: q.x, y: q.y };
    const d = drag.current;
    if (d && (tool === 'hand' || d.px !== undefined)) {
      view.current.ox = d.px! + (q.sx - d.x0);
      view.current.oy = d.py! + (q.sy - d.y0);
    } else if (d && (tool === 'brush' || tool === 'erase')) {
      stroke(d.x, d.y, q.x, q.y);
      d.x = q.x;
      d.y = q.y;
    } else if (d) {
      d.x = q.x;
      d.y = q.y;
    }
    render();
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && tool === 'rect' && d.px === undefined) {
      const c = ctx2d(mask.current!);
      c.globalCompositeOperation = subtract ? 'destination-out' : 'source-over';
      c.fillStyle = '#fff';
      c.fillRect(Math.min(d.x0, d.x), Math.min(d.y0, d.y), Math.abs(d.x - d.x0), Math.abs(d.y - d.y0));
      c.globalCompositeOperation = 'source-over';
      tintDirty.current = true;
    }
    if (d && d.px === undefined) updateEmpty();
    render();
  };
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const q = toImg(e);
    const v = view.current;
    const k = Math.min(20, Math.max(0.05, v.k * 0.999 ** e.deltaY));
    v.ox = q.sx - q.x * k;
    v.oy = q.sy - q.y * k;
    v.k = k;
    render();
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && tool === 'poly') closePoly();
      if (e.key === 'Backspace' && tool === 'poly' && poly.current.length) {
        poly.current.pop();
        render();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        doUndo();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const apply = async () => {
    if (!src.current || !mask.current) return;
    setBusy('Applying…');
    setErr(null);
    try {
      await p.onApply({ mask: readAlpha(), width: mask.current.width, height: mask.current.height, option, source: src.current.data });
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  };

  const ToolBtn = ({ t, label, title }: { t: Tool; label: string; title: string }) => (
    <button
      title={title}
      onClick={() => {
        if (tool === 'poly' && t !== 'poly') poly.current = [];
        setTool(t);
      }}
      className={`h-8 rounded-md px-2.5 text-xs font-medium ${tool === t ? 'bg-stone-900 text-white' : 'bg-white text-stone-700 ring-1 ring-stone-300 hover:bg-stone-100'}`}
    >
      {label}
    </button>
  );

  return (
    <Modal
      title={p.title}
      wide
      onClose={p.onCancel}
      footer={
        <>
          {p.option && (
            <label className="mr-auto flex items-center gap-2 text-sm">
              <input type="checkbox" checked={option} onChange={(e) => setOption(e.target.checked)} /> {p.option.label}
            </label>
          )}
          <Button onClick={p.onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!!busy || empty} onClick={apply}>{p.applyLabel}</Button>
        </>
      }
    >
      <div className="flex h-full min-h-[60vh] flex-col">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-stone-200 bg-stone-50 px-3 py-2">
          <ToolBtn t="brush" label="Brush" title="Paint the area to keep" />
          <ToolBtn t="erase" label="Eraser" title="Erase from the selection" />
          <ToolBtn t="rect" label="Rectangle" title="Drag a rectangle" />
          <ToolBtn t="poly" label="Polygon" title="Click points; click the first point or press Enter to close" />
          <ToolBtn t="hand" label="Pan" title="Drag to move the view (wheel zooms)" />
          {(tool === 'rect' || tool === 'poly') && (
            <label className="ml-1 flex items-center gap-1 text-xs">
              <input type="checkbox" checked={subtract} onChange={(e) => setSubtract(e.target.checked)} /> Subtract
            </label>
          )}
          {(tool === 'brush' || tool === 'erase') && (
            <div className="w-36"><Slider label="Brush size" value={brush} min={2} max={300} step={1} onChange={setBrush} format={(v) => `${v}px`} /></div>
          )}
          <span className="mx-1 h-6 w-px bg-stone-300" />
          <Button size="sm" onClick={autoDetect} disabled={!!busy} title="GrabCut on the whole image">Auto-detect object</Button>
          <Button size="sm" onClick={snap} disabled={!!busy || empty} title="Mask-initialised GrabCut snaps your rough selection to edges">Snap to edges</Button>
          <Button size="sm" onClick={invert} disabled={!!busy}>Invert</Button>
          <Button size="sm" onClick={() => fill(255)} disabled={!!busy}>All</Button>
          <Button size="sm" onClick={() => fill(0)} disabled={!!busy}>Clear</Button>
          <Button size="sm" onClick={doUndo} disabled={!undo.current.length}>Undo</Button>
          <Button size="sm" onClick={fit}>Fit</Button>
          <label className="ml-auto flex items-center gap-1.5 text-xs font-medium">
            <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} /> Preview cut-out
          </label>
        </div>
        {p.hint && <div className="border-b border-stone-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">{p.hint}</div>}
        {err && <div className="px-3 pt-2"><ErrorBox>{err}</ErrorBox></div>}
        <div ref={hostRef} className="relative min-h-0 flex-1 bg-stone-200" style={{ touchAction: 'none' }}>
          <canvas
            ref={viewRef}
            className={`absolute inset-0 ${tool === 'hand' ? 'cursor-grab' : 'cursor-crosshair'}`}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
            onPointerLeave={() => { cursor.current = null; render(); }}
            onDoubleClick={() => tool === 'poly' && closePoly()}
            onWheel={onWheel}
          />
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/60">
              <div className="flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm shadow"><Spinner /> {busy}</div>
            </div>
          )}
        </div>
        <div className="border-t border-stone-200 px-3 py-1.5 text-[11px] text-stone-500">
          Red = selected. Wheel to zoom. Polygon: click points, then click the first point, double-click or press Enter. Ctrl/⌘+Z undoes.
        </div>
      </div>
    </Modal>
  );
}
