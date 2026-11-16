import {
  Canvas,
  Circle,
  FabricImage,
  FabricObject,
  Point,
  Rect,
  Shadow,
  Textbox,
  Triangle,
  filters,
  util,
  type TMat2D,
} from 'fabric';
import { canvasToBlob, createCanvas, ctx2d, loadImageElement, uid } from '../lib/image';
import { processRaster, repaintUnder } from '../lib/raster';
import { DEFAULT_ADJ, type Adjustments, type Box, type Decomposition, type LayerKind, type LayerMeta } from '../lib/types';

export const FONTS = [
  'Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Times New Roman',
  'Courier New', 'Impact', 'system-ui', 'serif', 'sans-serif', 'monospace',
];

const HISTORY_LIMIT = 60;

export function metaOf(o: FabricObject): LayerMeta {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = o as any;
  if (!a.meta) a.meta = { id: uid('l'), name: o.type, kind: 'image' as LayerKind };
  return a.meta as LayerMeta;
}
function setMeta(o: FabricObject, m: LayerMeta) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (o as any).meta = m;
}

/** Canvas that draws a checkerboard under the document area (not exported). */
class StudioCanvas extends Canvas {
  docW = 1080;
  docH = 1080;
  exporting = false;
  private pattern: CanvasPattern | null = null;

  _renderBackground(ctx: CanvasRenderingContext2D) {
    if (!this.exporting) {
      if (!this.pattern) {
        const c = createCanvas(16, 16);
        const x = ctx2d(c);
        x.fillStyle = '#ffffff';
        x.fillRect(0, 0, 16, 16);
        x.fillStyle = '#e7e5e4';
        x.fillRect(0, 0, 8, 8);
        x.fillRect(8, 8, 8, 8);
        this.pattern = ctx.createPattern(c, 'repeat');
      }
      const v = this.viewportTransform;
      ctx.save();
      ctx.transform(v[0], v[1], v[2], v[3], v[4], v[5]);
      if (this.pattern) ctx.fillStyle = this.pattern;
      ctx.fillRect(0, 0, this.docW, this.docH);
      ctx.restore();
    }
    super._renderBackground(ctx);
  }
}

export interface LayerRow {
  obj: FabricObject;
  meta: LayerMeta;
  visible: boolean;
  locked: boolean;
  index: number; // stacking index (0 = bottom)
}

export interface ExportOptions {
  format: 'png' | 'jpeg';
  quality: number; // 0..1 for jpeg
  width: number;
  height: number;
  fit: 'contain' | 'cover' | 'stretch';
  pad: string; // padding colour for contain ('' = transparent)
}

export class Editor {
  canvas: StudioCanvas;
  private el: HTMLCanvasElement;
  private ro: ResizeObserver;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private suspend = 0;
  private pendingSnap: number | null = null;
  private listeners = new Set<() => void>();
  private spaceDown = false;
  private panning: { x: number; y: number } | null = null;
  handMode = false;
  disposed = false;
  /** increments on every recorded history change (used for "unsaved changes") */
  version = 0;

  constructor(private host: HTMLElement) {
    this.el = document.createElement('canvas');
    host.appendChild(this.el);
    this.canvas = new StudioCanvas(this.el, {
      preserveObjectStacking: true,
      controlsAboveOverlay: true,
      selection: true,
      backgroundColor: '',
      enableRetinaScaling: true,
      stopContextMenu: true,
      fireMiddleClick: true,
    });
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.bindEvents();
  }

  // ------------------------------------------------------------ lifecycle
  dispose() {
    this.disposed = true;
    this.ro.disconnect();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    void this.canvas.dispose();
    this.el.remove();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((l) => l());
  }

  private resize() {
    const r = this.host.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    this.canvas.setDimensions({ width: r.width, height: r.height });
    this.canvas.requestRenderAll();
  }

  private bindEvents() {
    const c = this.canvas;
    const changed = () => {
      this.scheduleSnapshot();
      this.emit();
    };
    c.on('object:modified', changed);
    c.on('object:added', changed);
    c.on('object:removed', changed);
    c.on('text:changed', changed);
    c.on('selection:created', () => this.emit());
    c.on('selection:updated', () => this.emit());
    c.on('selection:cleared', () => this.emit());

    c.on('mouse:wheel', (opt) => {
      const e = opt.e as WheelEvent;
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        const z = util.capValue(0.05, c.getZoom() * 0.999 ** e.deltaY, 16);
        c.zoomToPoint(new Point(e.offsetX, e.offsetY), z);
      } else {
        c.relativePan(new Point(-e.deltaX, -e.deltaY));
      }
      this.emit();
    });
    c.on('mouse:down', (opt) => {
      const e = opt.e as MouseEvent;
      if (this.handMode || this.spaceDown || e.button === 1) {
        const p = 'touches' in e ? (e as unknown as TouchEvent).touches[0] : e;
        this.panning = { x: p.clientX, y: p.clientY };
        c.selection = false;
        c.discardActiveObject();
        c.setCursor('grabbing');
      }
    });
    c.on('mouse:move', (opt) => {
      if (!this.panning) return;
      const e = opt.e as MouseEvent;
      const p = 'touches' in e ? (e as unknown as TouchEvent).touches[0] : e;
      c.relativePan(new Point(p.clientX - this.panning.x, p.clientY - this.panning.y));
      this.panning = { x: p.clientX, y: p.clientY };
    });
    c.on('mouse:up', () => {
      if (this.panning) {
        this.panning = null;
        c.selection = !this.handMode;
        this.emit();
      }
    });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const active = this.canvas.getActiveObject();
    if (active instanceof Textbox && active.isEditing) return;
    if (e.code === 'Space') {
      this.spaceDown = true;
      e.preventDefault();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) void this.redo();
      else void this.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      void this.redo();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && active) {
      e.preventDefault();
      this.deleteActive();
    } else if (active && e.key.startsWith('Arrow') && !metaOf(active).locked) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') active.set('left', active.left - d);
      if (e.key === 'ArrowRight') active.set('left', active.left + d);
      if (e.key === 'ArrowUp') active.set('top', active.top - d);
      if (e.key === 'ArrowDown') active.set('top', active.top + d);
      active.setCoords();
      this.canvas.requestRenderAll();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.canvas as any).fire('object:modified', { target: active });
    }
  };
  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') this.spaceDown = false;
  };

  setHandMode(on: boolean) {
    this.handMode = on;
    this.canvas.selection = !on;
    this.canvas.defaultCursor = on ? 'grab' : 'default';
    this.canvas.forEachObject((o) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (o as any).__evented ??= o.evented;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      o.evented = on ? false : (o as any).__evented;
    });
    this.emit();
  }

  // ------------------------------------------------------------ document
  setDocSize(w: number, h: number) {
    this.canvas.docW = w;
    this.canvas.docH = h;
    const clip = new Rect({ left: 0, top: 0, width: w, height: h, originX: 'left', originY: 'top', absolutePositioned: true });
    clip.excludeFromExport = true;
    this.canvas.clipPath = clip;
    this.fit();
  }
  get docW() {
    return this.canvas.docW;
  }
  get docH() {
    return this.canvas.docH;
  }

  fit() {
    const c = this.canvas;
    const pad = 32;
    const z = Math.min((c.width - pad * 2) / this.docW, (c.height - pad * 2) / this.docH);
    const zoom = Math.max(0.02, z);
    c.setViewportTransform([zoom, 0, 0, zoom, (c.width - this.docW * zoom) / 2, (c.height - this.docH * zoom) / 2] as TMat2D);
    this.emit();
  }
  zoomBy(f: number) {
    const c = this.canvas;
    c.zoomToPoint(new Point(c.width / 2, c.height / 2), util.capValue(0.05, c.getZoom() * f, 16));
    this.emit();
  }
  get zoom() {
    return this.canvas.getZoom();
  }

  // ------------------------------------------------------------ history
  private serialize(): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o = (this.canvas as any).toObject(['meta']);
    delete o.clipPath;
    return JSON.stringify({ docW: this.docW, docH: this.docH, canvas: o });
  }
  toJSON(): string {
    this.flushSnapshot();
    return this.serialize();
  }
  async loadJSON(json: string, resetHistory = true) {
    const parsed = JSON.parse(json) as { docW: number; docH: number; canvas: object };
    this.suspend++;
    try {
      this.canvas.discardActiveObject();
      await this.canvas.loadFromJSON(parsed.canvas);
      this.canvas.backgroundColor = '';
      if (parsed.docW !== this.docW || parsed.docH !== this.docH || !this.canvas.clipPath) this.setDocSize(parsed.docW, parsed.docH);
      this.canvas.forEachObject((o) => this.applyLock(o, !!metaOf(o).locked));
      this.canvas.requestRenderAll();
    } finally {
      this.suspend--;
    }
    if (resetHistory) {
      this.undoStack = [this.serialize()];
      this.redoStack = [];
    }
    this.emit();
  }

  private scheduleSnapshot() {
    if (this.suspend) return;
    if (this.pendingSnap) clearTimeout(this.pendingSnap);
    this.pendingSnap = window.setTimeout(() => this.flushSnapshot(), 250);
  }
  private flushSnapshot() {
    if (this.pendingSnap) {
      clearTimeout(this.pendingSnap);
      this.pendingSnap = null;
    } else return;
    if (this.suspend) return;
    const s = this.serialize();
    if (this.undoStack[this.undoStack.length - 1] === s) return;
    this.undoStack.push(s);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.version++;
    this.emit();
  }
  /** Record a snapshot right now (after programmatic changes). */
  commit() {
    if (this.suspend) return;
    this.pendingSnap = this.pendingSnap ?? -1;
    this.flushSnapshot();
  }
  get canUndo() {
    return this.undoStack.length > 1 || this.pendingSnap !== null;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  async undo() {
    this.flushSnapshot();
    if (this.undoStack.length < 2) return;
    this.redoStack.push(this.undoStack.pop()!);
    this.version++;
    await this.loadJSON(this.undoStack[this.undoStack.length - 1], false);
  }
  async redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(s);
    this.version++;
    await this.loadJSON(s, false);
  }

  // ------------------------------------------------------------ building
  async loadDecomposition(dec: Decomposition) {
    this.suspend++;
    try {
      this.canvas.clear();
      this.canvas.backgroundColor = '';
      this.setDocSize(dec.docW, dec.docH);
      for (const l of dec.layers) {
        if (!l.include) continue;
        const img = await FabricImage.fromURL(l.url);
        img.set({ left: l.box.x, top: l.box.y, originX: 'left', originY: 'top', visible: l.visible });
        setMeta(img, {
          id: l.id, name: l.name, kind: l.kind, confidence: l.confidence, note: l.note,
          baseSrc: l.kind === 'original' ? undefined : l.url,
          origBox: l.box, ocrText: l.text, textColor: l.textColor, fontSize: l.fontSize,
          onObject: l.onObject, parentId: l.parentId, parentBg: l.parentBg,
          locked: l.kind === 'original', adj: { ...DEFAULT_ADJ },
        });
        this.applyLock(img, l.kind === 'original');
        this.canvas.add(img);
      }
      this.canvas.requestRenderAll();
    } finally {
      this.suspend--;
    }
    this.undoStack = [this.serialize()];
    this.redoStack = [];
    this.emit();
  }

  private center(): Point {
    return new Point(this.docW / 2, this.docH / 2);
  }

  async addImage(url: string, name: string, kind: LayerKind = 'image', opts: { box?: Box; fitInto?: Box } = {}) {
    const img = await FabricImage.fromURL(url);
    setMeta(img, { id: uid(kind), name, kind, baseSrc: url, adj: { ...DEFAULT_ADJ }, origBox: opts.box });
    if (opts.box) {
      img.set({ left: opts.box.x, top: opts.box.y, originX: 'left', originY: 'top' });
    } else {
      const target = opts.fitInto ?? { x: this.docW * 0.15, y: this.docH * 0.15, w: this.docW * 0.7, h: this.docH * 0.7 };
      const s = Math.min(target.w / img.width, target.h / img.height, opts.fitInto ? Infinity : 1);
      img.set({ scaleX: s, scaleY: s, originX: 'left', originY: 'top' });
      img.setPositionByOrigin(new Point(target.x + target.w / 2, target.y + target.h / 2), 'center', 'center');
    }
    this.canvas.add(img);
    this.canvas.setActiveObject(img);
    this.canvas.requestRenderAll();
    return img;
  }

  addText(text = 'Your text') {
    const t = new Textbox(text, {
      left: this.docW * 0.1, top: this.docH * 0.1, width: this.docW * 0.6, fontSize: Math.round(this.docW / 14),
      fill: '#111827', fontFamily: 'Arial', fontWeight: 'bold', textAlign: 'left', originX: 'left', originY: 'top',
    });
    setMeta(t, { id: uid('text'), name: `Text: ${text}`, kind: 'text' });
    this.canvas.add(t);
    this.canvas.setActiveObject(t);
    this.canvas.requestRenderAll();
    return t;
  }

  addShape(shape: 'rect' | 'circle' | 'triangle') {
    const s = Math.round(Math.min(this.docW, this.docH) / 4);
    const common = { left: this.docW / 2 - s / 2, top: this.docH / 2 - s / 2, fill: '#f59e0b', originX: 'left' as const, originY: 'top' as const };
    const o =
      shape === 'rect' ? new Rect({ ...common, width: s, height: s * 0.6, rx: 8, ry: 8 })
        : shape === 'circle' ? new Circle({ ...common, radius: s / 2 })
          : new Triangle({ ...common, width: s, height: s });
    setMeta(o, { id: uid('shape'), name: shape[0].toUpperCase() + shape.slice(1), kind: 'shape' });
    this.canvas.add(o);
    this.canvas.setActiveObject(o);
    this.canvas.requestRenderAll();
    return o;
  }

  // ------------------------------------------------------------ layers
  layers(): LayerRow[] {
    return this.canvas
      .getObjects()
      .map((obj, index) => ({ obj, meta: metaOf(obj), visible: obj.visible !== false, locked: !!metaOf(obj).locked, index }))
      .reverse();
  }
  get active(): FabricObject | undefined {
    return this.canvas.getActiveObject() ?? undefined;
  }
  findById(id: string) {
    return this.canvas.getObjects().find((o) => metaOf(o).id === id);
  }
  select(o: FabricObject) {
    if (!o.visible) return;
    this.canvas.setActiveObject(o);
    this.canvas.requestRenderAll();
    this.emit();
  }
  rename(o: FabricObject, name: string) {
    metaOf(o).name = name;
    this.changed();
  }
  toggleVisible(o: FabricObject) {
    o.visible = !o.visible;
    if (!o.visible && this.canvas.getActiveObject() === o) this.canvas.discardActiveObject();
    this.changed();
  }
  private applyLock(o: FabricObject, locked: boolean) {
    o.set({
      lockMovementX: locked, lockMovementY: locked, lockScalingX: locked, lockScalingY: locked, lockRotation: locked,
      hasControls: !locked, editable: !locked,
    } as Partial<FabricObject>);
  }
  toggleLock(o: FabricObject) {
    const m = metaOf(o);
    m.locked = !m.locked;
    this.applyLock(o, m.locked);
    this.changed();
  }
  deleteActive() {
    const objs = this.canvas.getActiveObjects();
    if (!objs.length) return;
    if (objs.some((o) => metaOf(o).locked)) return;
    this.canvas.discardActiveObject();
    objs.forEach((o) => this.canvas.remove(o));
    this.changed();
  }
  remove(o: FabricObject) {
    if (this.canvas.getActiveObject() === o) this.canvas.discardActiveObject();
    this.canvas.remove(o);
    this.changed();
  }
  async duplicate(o: FabricObject) {
    const copy = await o.clone(['meta']);
    const m = { ...metaOf(o), id: uid(metaOf(o).kind), name: metaOf(o).name + ' copy', locked: false };
    setMeta(copy, m);
    this.applyLock(copy, false);
    copy.set({ left: o.left + 20, top: o.top + 20 });
    this.canvas.add(copy);
    this.canvas.setActiveObject(copy);
    this.changed();
  }
  forward(o: FabricObject) {
    this.canvas.bringObjectForward(o);
    this.changed();
  }
  backward(o: FabricObject) {
    this.canvas.sendObjectBackwards(o);
    this.changed();
  }
  toFront(o: FabricObject) {
    this.canvas.bringObjectToFront(o);
    this.changed();
  }
  toBack(o: FabricObject) {
    this.canvas.sendObjectToBack(o);
    this.changed();
  }
  moveTo(o: FabricObject, index: number) {
    this.canvas.moveObjectTo(o, index);
    this.changed();
  }
  /** Programmatic change: re-render, record history, notify UI. */
  changed() {
    this.canvas.requestRenderAll();
    this.scheduleSnapshot();
    this.emit();
  }
  /** Live update (e.g. slider drag) without a history entry until `changed()`. */
  touch() {
    this.canvas.requestRenderAll();
    this.emit();
  }

  // ------------------------------------------------------------ properties
  setProps(o: FabricObject, props: Record<string, unknown>, record = true) {
    o.set(props as Partial<FabricObject>);
    o.setCoords();
    if (record) this.changed();
    else this.touch();
  }

  setAdjustments(o: FabricObject, adj: Adjustments, record = true) {
    if (!(o instanceof FabricImage)) return;
    metaOf(o).adj = adj;
    const f: FabricImage['filters'] = [];
    if (adj.brightness) f.push(new filters.Brightness({ brightness: adj.brightness }));
    if (adj.contrast) f.push(new filters.Contrast({ contrast: adj.contrast }));
    if (adj.saturation) f.push(new filters.Saturation({ saturation: adj.saturation }));
    if (adj.temperature) {
      const t = adj.temperature;
      f.push(new filters.ColorMatrix({ matrix: [1 + 0.2 * t, 0, 0, 0, 0.03 * t, 0, 1, 0, 0, 0, 0, 0, 1 - 0.2 * t, 0, -0.03 * t, 0, 0, 0, 1, 0] }));
    }
    if (adj.blur) f.push(new filters.Blur({ blur: adj.blur }));
    o.filters = f;
    o.applyFilters();
    if (record) this.changed();
    else this.touch();
  }

  setShadow(o: FabricObject, s: { on: boolean; blur: number; offset: number; opacity: number; color?: string }) {
    o.shadow = s.on
      ? new Shadow({ color: hexA(s.color ?? '#000000', s.opacity), blur: s.blur, offsetX: s.offset, offsetY: s.offset * 1.2, affectStroke: false })
      : null;
    o.dirty = true;
    this.changed();
  }

  /** Crop as fractions of the source image, keeping the visible content in place. */
  setCrop(o: FabricImage, c: { l: number; t: number; r: number; b: number }) {
    const el = o.getElement() as HTMLImageElement;
    const nw = el.naturalWidth || el.width, nh = el.naturalHeight || el.height;
    const cropX = Math.round(nw * c.l), cropY = Math.round(nh * c.t);
    const width = Math.max(4, Math.round(nw * (1 - c.l - c.r))), height = Math.max(4, Math.round(nh * (1 - c.t - c.b)));
    const local = new Point(cropX - o.cropX - o.width / 2, cropY - o.cropY - o.height / 2);
    const tl = util.transformPoint(local, o.calcTransformMatrix());
    o.set({ cropX, cropY, width, height });
    o.setPositionByOrigin(tl, 'left', 'top');
    o.setCoords();
    this.changed();
  }

  /** Swap the pixels of an image layer, keeping position/filters. */
  async setImageSrc(o: FabricImage, url: string) {
    const el = await loadImageElement(url);
    const center = o.getCenterPoint();
    const dispW = o.getScaledWidth(), dispH = o.getScaledHeight();
    const sameSize = el.naturalWidth === o.width && el.naturalHeight === o.height && !o.cropX && !o.cropY;
    o.setElement(el);
    if (!sameSize) {
      const s = Math.min(dispW / el.naturalWidth, dispH / el.naturalHeight);
      o.set({ scaleX: s * Math.sign(o.scaleX || 1), scaleY: s * Math.sign(o.scaleY || 1), cropX: 0, cropY: 0 });
      o.setPositionByOrigin(center, 'center', 'center');
    }
    o.applyFilters();
    o.setCoords();
    o.dirty = true;
  }

  /** Canvas point of a pixel (px,py) of an image layer's source element. */
  pointOnLayer(o: FabricImage, px: number, py: number): Point {
    return util.transformPoint(new Point(px - o.cropX - o.width / 2, py - o.cropY - o.height / 2), o.calcTransformMatrix());
  }

  /**
   * Give an image layer a new cut-out. (dx,dy) is where the new image's top-left
   * pixel sits in the old image's pixel space, so the content stays in place
   * whatever the layer's scale / rotation.
   */
  async setCutout(o: FabricImage, url: string, dx: number, dy: number, origBox?: Box) {
    const m = metaOf(o);
    const tl = this.pointOnLayer(o, dx, dy);
    m.baseSrc = url;
    if (origBox) m.origBox = origBox;
    const shown = !m.feather && !m.colorMatch ? url : await processRaster(url, { feather: m.feather, colorMatch: m.colorMatch });
    const el = await loadImageElement(shown);
    o.setElement(el);
    o.set({ cropX: 0, cropY: 0 });
    o.setPositionByOrigin(tl, 'left', 'top');
    o.applyFilters();
    o.setCoords();
    o.dirty = true;
    this.changed();
  }

  /** Add a cut-out taken from pixels of another image layer, at the same visual place. */
  async addFromLayer(src: FabricImage, url: string, box: Box, name: string) {
    const img = await FabricImage.fromURL(url);
    img.set({ scaleX: src.scaleX, scaleY: src.scaleY, angle: src.angle, flipX: src.flipX, flipY: src.flipY, originX: 'left', originY: 'top' });
    setMeta(img, { id: uid('object'), name, kind: 'object', baseSrc: url, adj: { ...DEFAULT_ADJ }, confidence: 'manual', note: 'Extracted with manual selection.' });
    img.setPositionByOrigin(this.pointOnLayer(src, box.x + box.w / 2, box.y + box.h / 2), 'center', 'center');
    const idx = this.canvas.getObjects().indexOf(src);
    this.canvas.insertAt(idx + 1, img);
    this.canvas.setActiveObject(img);
    this.changed();
    return img;
  }

  /** Change the document size, keeping content centred. */
  resizeDoc(w: number, h: number) {
    const dx = (w - this.docW) / 2, dy = (h - this.docH) / 2;
    this.canvas.getObjects().forEach((o) => {
      o.set({ left: o.left + dx, top: o.top + dy });
      o.setCoords();
    });
    this.setDocSize(w, h);
    this.changed();
  }

  /** Re-run colour match + feather from the untouched cut-out. */
  async reprocess(o: FabricImage) {
    const m = metaOf(o);
    if (!m.baseSrc) return;
    const url = !m.feather && !m.colorMatch ? m.baseSrc : await processRaster(m.baseSrc, { feather: m.feather, colorMatch: m.colorMatch });
    const center = o.getCenterPoint();
    const el = await loadImageElement(url);
    o.setElement(el);
    o.setPositionByOrigin(center, 'center', 'center');
    o.applyFilters();
    o.dirty = true;
    this.changed();
  }

  /**
   * Replace a layer's image with a new cut-out. The new image is fitted into the
   * old layer's on-canvas footprint (same centre, same rotation).
   */
  async replaceImage(o: FabricObject, url: string, name?: string) {
    const center = o.getCenterPoint();
    const w = o.getScaledWidth(), h = o.getScaledHeight();
    const el = await loadImageElement(url);
    const s = Math.min(w / el.naturalWidth, h / el.naturalHeight);
    const img = new FabricImage(el, { scaleX: s, scaleY: s, angle: o.angle, originX: 'left', originY: 'top' });
    img.setPositionByOrigin(center, 'center', 'center');
    const old = metaOf(o);
    setMeta(img, {
      id: uid(old.kind), name: name ?? old.name.replace(/ \(replaced\)$/, '') + ' (replaced)', kind: old.kind === 'background' ? 'background' : old.kind === 'text' ? 'image' : old.kind,
      baseSrc: url, adj: { ...DEFAULT_ADJ }, note: 'Replacement image.',
    });
    const idx = this.canvas.getObjects().indexOf(o);
    this.suspend++;
    this.canvas.remove(o);
    this.canvas.insertAt(idx, img);
    this.suspend--;
    this.canvas.setActiveObject(img);
    this.changed();
    return img;
  }

  /** Turn an OCR raster text layer into a live editable Textbox. */
  async convertToEditableText(o: FabricImage) {
    const m = metaOf(o);
    const br = o.getBoundingRect();
    const fontSize = Math.round((m.fontSize ?? o.getScaledHeight() * 0.8) * Math.abs(o.scaleY));
    const t = new Textbox(m.ocrText ?? 'Text', {
      left: br.left, top: br.top + (o.getScaledHeight() - fontSize * 1.16) / 2, width: Math.max(40, br.width * 1.08),
      fontSize, fill: m.textColor ?? '#111111', fontFamily: 'Arial', fontWeight: 'bold', originX: 'left', originY: 'top', angle: o.angle,
    });
    setMeta(t, { id: uid('text'), name: m.name, kind: 'text', confidence: m.confidence, note: 'Editable text (font is approximate).' });
    // If the text was painted on an object (button, label) repaint the object under it.
    if (m.onObject && m.parentId && m.parentBg && m.origBox && m.baseSrc) {
      const parent = this.findById(m.parentId);
      const pm = parent && metaOf(parent);
      if (parent instanceof FabricImage && pm?.baseSrc && pm.origBox) {
        pm.baseSrc = await repaintUnder(pm.baseSrc, m.baseSrc, m.origBox.x - pm.origBox.x, m.origBox.y - pm.origBox.y, m.parentBg);
        await this.reprocess(parent);
      }
    }
    const idx = this.canvas.getObjects().indexOf(o);
    this.suspend++;
    this.canvas.remove(o);
    this.canvas.insertAt(idx, t);
    this.suspend--;
    this.canvas.setActiveObject(t);
    this.changed();
    return t;
  }

  /** Background helpers. The background is a normal layer of kind 'background'. */
  private backgroundLayers() {
    return this.canvas.getObjects().filter((o) => metaOf(o).kind === 'background');
  }
  setBackgroundColor(color: string) {
    const existing = this.backgroundLayers();
    const r = new Rect({ left: 0, top: 0, width: this.docW, height: this.docH, fill: color, originX: 'left', originY: 'top' });
    setMeta(r, { id: uid('bg'), name: 'Background colour', kind: 'background' });
    this.suspend++;
    existing.forEach((o) => (o.visible = false));
    const firstVisibleIdx = this.firstNonOriginalIndex();
    this.canvas.insertAt(firstVisibleIdx, r);
    this.suspend--;
    this.changed();
  }
  async setBackgroundImage(url: string) {
    const el = await loadImageElement(url);
    const s = Math.max(this.docW / el.naturalWidth, this.docH / el.naturalHeight); // cover
    const img = new FabricImage(el, { scaleX: s, scaleY: s, originX: 'left', originY: 'top' });
    img.setPositionByOrigin(this.center(), 'center', 'center');
    setMeta(img, { id: uid('bg'), name: 'Background image', kind: 'background', baseSrc: url, adj: { ...DEFAULT_ADJ } });
    this.suspend++;
    this.backgroundLayers().forEach((o) => (o.visible = false));
    this.canvas.insertAt(this.firstNonOriginalIndex(), img);
    this.suspend--;
    this.changed();
  }
  setTransparentBackground() {
    this.backgroundLayers().forEach((o) => (o.visible = false));
    this.canvas.getObjects().filter((o) => metaOf(o).kind === 'original').forEach((o) => (o.visible = false));
    this.canvas.discardActiveObject();
    this.changed();
  }
  private firstNonOriginalIndex() {
    const objs = this.canvas.getObjects();
    let i = 0;
    while (i < objs.length && metaOf(objs[i]).kind === 'original') i++;
    return i;
  }

  // ------------------------------------------------------------ export
  /** Render the document at `scale` with no viewport transform. */
  renderDoc(scale = 1): HTMLCanvasElement {
    const c = this.canvas;
    const vpt = [...c.viewportTransform] as TMat2D;
    const active = c.getActiveObject();
    c.exporting = true;
    c.discardActiveObject();
    c.setViewportTransform([1, 0, 0, 1, 0, 0]);
    try {
      return c.toCanvasElement(scale, { left: 0, top: 0, width: this.docW, height: this.docH });
    } finally {
      c.exporting = false;
      c.setViewportTransform(vpt);
      if (active) c.setActiveObject(active);
      c.requestRenderAll();
    }
  }

  async exportComposition(o: ExportOptions): Promise<Blob> {
    const sx = o.width / this.docW, sy = o.height / this.docH;
    const scale = o.fit === 'contain' ? Math.min(sx, sy) : o.fit === 'cover' ? Math.max(sx, sy) : Math.max(sx, sy);
    const src = this.renderDoc(scale);
    const out = createCanvas(o.width, o.height);
    const ctx = ctx2d(out);
    ctx.imageSmoothingQuality = 'high';
    if (o.format === 'jpeg') {
      ctx.fillStyle = o.pad || '#ffffff';
      ctx.fillRect(0, 0, o.width, o.height);
    } else if (o.pad && o.fit === 'contain') {
      ctx.fillStyle = o.pad;
      ctx.fillRect(0, 0, o.width, o.height);
    }
    if (o.fit === 'stretch') ctx.drawImage(src, 0, 0, o.width, o.height);
    else {
      const dw = this.docW * scale, dh = this.docH * scale;
      ctx.drawImage(src, (o.width - dw) / 2, (o.height - dh) / 2, dw, dh);
    }
    return canvasToBlob(out, o.format === 'png' ? 'image/png' : 'image/jpeg', o.quality);
  }

  /** One layer as a transparent PNG, as it appears (transforms + filters), trimmed to its bounds. */
  async exportLayer(o: FabricObject): Promise<Blob> {
    const wasVisible = o.visible;
    o.visible = true;
    const angleFree = o.toCanvasElement({ multiplier: 1, enableRetinaScaling: false });
    o.visible = wasVisible;
    return canvasToBlob(angleFree);
  }

  async thumbnail(): Promise<Blob> {
    const scale = Math.min(1, 360 / Math.max(this.docW, this.docH));
    const src = this.renderDoc(scale);
    const out = createCanvas(src.width, src.height);
    const ctx = ctx2d(out);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    return canvasToBlob(out, 'image/jpeg', 0.8);
  }
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
