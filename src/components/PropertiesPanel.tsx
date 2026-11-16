import { ActiveSelection, Circle, FabricImage, Rect, Shadow, Textbox, Triangle, type FabricObject } from 'fabric';
import { useState } from 'react';
import { FONTS, metaOf, type Editor } from '../editor/Editor';
import { DEFAULT_ADJ, type Adjustments } from '../lib/types';
import { Button, ConfidenceBadge, NumberField, Section, Slider } from './ui';

export interface LayerActions {
  replace: (o: FabricObject) => void;
  refine: (o: FabricObject) => void;
  removeBackground: (o: FabricObject) => void;
  exportLayer: (o: FabricObject) => void;
  canRefine: (o: FabricObject) => boolean;
}

export default function PropertiesPanel({ editor, actions }: { editor: Editor; actions: LayerActions }) {
  const o = editor.active;
  if (!o) {
    return (
      <div className="px-3 py-6 text-center text-xs text-stone-400">
        Select a layer on the canvas or in the list to edit its properties.
      </div>
    );
  }
  if (o instanceof ActiveSelection) {
    return <div className="px-3 py-6 text-center text-xs text-stone-500">{editor.canvas.getActiveObjects().length} layers selected. Move or scale them together, or press Delete.</div>;
  }
  const m = metaOf(o);
  return (
    <div key={m.id}>
      <Section title="Layer" right={<ConfidenceBadge c={m.confidence} />}>
        <div className="text-xs text-stone-600">
          <span className="font-medium text-stone-800">{m.name}</span> · {m.kind}
          {m.locked && <span className="ml-1 text-stone-500">(locked)</span>}
        </div>
        {m.note && <p className="text-[11px] leading-snug text-stone-500">{m.note}</p>}
      </Section>
      {o instanceof FabricImage && m.kind === 'text' && m.ocrText !== undefined && <OcrTextSection o={o} editor={editor} />}
      <TransformSection o={o} editor={editor} />
      {o instanceof FabricImage && <ImageSection o={o} editor={editor} actions={actions} />}
      {o instanceof Textbox && <TextSection o={o} editor={editor} />}
      {(o instanceof Rect || o instanceof Circle || o instanceof Triangle) && <ShapeSection o={o} editor={editor} />}
      <ShadowSection o={o} editor={editor} />
      <Section title="Export">
        <Button size="sm" className="w-full" onClick={() => actions.exportLayer(o)}>Download this layer as PNG</Button>
      </Section>
    </div>
  );
}

function TransformSection({ o, editor }: { o: FabricObject; editor: Editor }) {
  const locked = !!metaOf(o).locked;
  const [op, setOp] = useState(o.opacity ?? 1);
  return (
    <Section title="Position & size">
      <fieldset disabled={locked} className="grid grid-cols-2 gap-1.5 disabled:opacity-50">
        <NumberField label="X" value={o.left} onChange={(v) => editor.setProps(o, { left: v })} />
        <NumberField label="Y" value={o.top} onChange={(v) => editor.setProps(o, { top: v })} />
        <NumberField label="W" min={1} value={o.getScaledWidth()} onChange={(v) => v > 0 && editor.setProps(o, { scaleX: (v / o.width) * Math.sign(o.scaleX || 1) })} />
        <NumberField label="H" min={1} value={o.getScaledHeight()} onChange={(v) => v > 0 && editor.setProps(o, { scaleY: (v / o.height) * Math.sign(o.scaleY || 1) })} />
        <NumberField label="∠" value={o.angle} onChange={(v) => {
          o.rotate(v);
          editor.changed();
        }} />
        <div className="flex gap-1">
          <Button size="sm" className="flex-1" title="Flip horizontally" onClick={() => editor.setProps(o, { flipX: !o.flipX })}>⇋</Button>
          <Button size="sm" className="flex-1" title="Flip vertically" onClick={() => editor.setProps(o, { flipY: !o.flipY })}>⇵</Button>
        </div>
      </fieldset>
      <Slider
        label="Opacity" value={op} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => {
          setOp(v);
          editor.setProps(o, { opacity: v }, false);
        }}
        onCommit={() => editor.changed()}
      />
    </Section>
  );
}

function OcrTextSection({ o, editor }: { o: FabricImage; editor: Editor }) {
  const m = metaOf(o);
  const [busy, setBusy] = useState(false);
  return (
    <Section title="Detected text">
      <p className="rounded-md bg-stone-100 px-2 py-1.5 font-mono text-xs">{m.ocrText}</p>
      <p className="text-[11px] text-stone-500">This layer holds the original text pixels. Convert it to edit the words, font, size and colour. The original font cannot be recovered.</p>
      <Button
        size="sm" variant="primary" className="w-full" disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await editor.convertToEditableText(o);
          } finally {
            setBusy(false);
          }
        }}
      >
        Convert to editable text
      </Button>
      <Button size="sm" variant="danger" className="w-full" onClick={() => editor.remove(o)}>Delete original text</Button>
    </Section>
  );
}

function ImageSection({ o, editor, actions }: { o: FabricImage; editor: Editor; actions: LayerActions }) {
  const m = metaOf(o);
  const [adj, setAdj] = useState<Adjustments>(m.adj ?? { ...DEFAULT_ADJ });
  const [feather, setFeather] = useState(m.feather ?? 0);
  const [busy, setBusy] = useState<string | null>(null);
  const el = o.getElement() as HTMLImageElement;
  const nw = el.naturalWidth || el.width || 1, nh = el.naturalHeight || el.height || 1;
  const [crop, setCrop] = useState({ l: o.cropX / nw, t: o.cropY / nh, r: 1 - (o.cropX + o.width) / nw, b: 1 - (o.cropY + o.height) / nh });
  const locked = !!m.locked;
  const isOriginal = m.kind === 'original';

  const updAdj = (k: keyof Adjustments, v: number, record: boolean) => {
    const next = { ...adj, [k]: v };
    setAdj(next);
    editor.setAdjustments(o, next, record);
  };
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {!isOriginal && (
        <Section title="Image">
          <div className="grid grid-cols-2 gap-1.5">
            <Button size="sm" disabled={locked} onClick={() => actions.replace(o)}>Replace…</Button>
            <Button size="sm" disabled={locked || !actions.canRefine(o)} onClick={() => actions.refine(o)} title="Edit this layer's selection on the original image">Refine mask</Button>
            <Button size="sm" disabled={locked} className="col-span-2" onClick={() => actions.removeBackground(o)}>Remove background…</Button>
          </div>
          {m.baseSrc && (
            <Slider
              label="Edge feather" value={feather} min={0} max={30} step={1} format={(v) => `${v}px`}
              onChange={setFeather}
              onCommit={(v) => run('feather', async () => {
                m.feather = v;
                await editor.reprocess(o);
              })}
            />
          )}
          {m.matchTarget && (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox" checked={!!m.colorMatch} disabled={!!busy}
                onChange={(e) => run('match', async () => {
                  m.colorMatch = e.target.checked ? m.matchTarget : null;
                  await editor.reprocess(o);
                })}
              />
              Match colours to the replaced layer
            </label>
          )}
          {busy && <p className="text-[11px] text-stone-500">Processing…</p>}
        </Section>
      )}
      <Section title="Adjustments" right={<button className="text-[11px] text-stone-500 hover:text-stone-900" onClick={() => { setAdj({ ...DEFAULT_ADJ }); editor.setAdjustments(o, { ...DEFAULT_ADJ }); }}>Reset</button>}>
        {(['brightness', 'contrast', 'saturation', 'temperature'] as const).map((k) => (
          <Slider
            key={k} label={k[0].toUpperCase() + k.slice(1)} value={adj[k]} min={-1} max={1} format={(v) => `${Math.round(v * 100)}`}
            onChange={(v) => updAdj(k, v, false)} onCommit={() => editor.changed()}
          />
        ))}
        <Slider label="Gaussian blur" value={adj.blur} min={0} max={1} format={(v) => `${Math.round(v * 100)}`} onChange={(v) => updAdj('blur', v, false)} onCommit={() => editor.changed()} />
      </Section>
      <Section title="Crop">
        {(['l', 't', 'r', 'b'] as const).map((k) => (
          <Slider
            key={k} label={{ l: 'Left', t: 'Top', r: 'Right', b: 'Bottom' }[k]} value={crop[k]} min={0} max={0.45} step={0.005}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => setCrop({ ...crop, [k]: v })}
            onCommit={(v) => !locked && editor.setCrop(o, { ...crop, [k]: v })}
          />
        ))}
      </Section>
    </>
  );
}

function TextSection({ o, editor }: { o: Textbox; editor: Editor }) {
  const [text, setText] = useState(o.text);
  const set = (p: Record<string, unknown>) => editor.setProps(o, p);
  return (
    <Section title="Text">
      <textarea
        value={text} rows={3} className="w-full rounded-md border border-stone-300 px-2 py-1 text-sm"
        onChange={(e) => {
          setText(e.target.value);
          editor.setProps(o, { text: e.target.value }, false);
        }}
        onBlur={() => {
          metaOf(o).name = `Text: ${text.slice(0, 28)}`;
          editor.changed();
        }}
      />
      <select value={o.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })} className="w-full rounded-md border border-stone-300 px-2 py-1 text-sm">
        {FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
      </select>
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField label="pt" min={4} value={o.fontSize} onChange={(v) => v >= 4 && set({ fontSize: v })} />
        <label className="flex items-center gap-1.5 rounded-md border border-stone-200 px-2 text-xs">
          Colour <input type="color" value={toHex(o.fill)} onChange={(e) => editor.setProps(o, { fill: e.target.value }, false)} onBlur={() => editor.changed()} className="h-6 w-full" />
        </label>
      </div>
      <div className="flex gap-1">
        <Button size="sm" variant={o.fontWeight === 'bold' ? 'primary' : 'secondary'} onClick={() => set({ fontWeight: o.fontWeight === 'bold' ? 'normal' : 'bold' })}><b>B</b></Button>
        <Button size="sm" variant={o.fontStyle === 'italic' ? 'primary' : 'secondary'} onClick={() => set({ fontStyle: o.fontStyle === 'italic' ? 'normal' : 'italic' })}><i>I</i></Button>
        <Button size="sm" variant={o.underline ? 'primary' : 'secondary'} onClick={() => set({ underline: !o.underline })}><u>U</u></Button>
        <span className="mx-1 w-px bg-stone-200" />
        {(['left', 'center', 'right', 'justify'] as const).map((a) => (
          <Button key={a} size="sm" variant={o.textAlign === a ? 'primary' : 'secondary'} title={`Align ${a}`} onClick={() => set({ textAlign: a })}>
            {{ left: '⯇', center: '≡', right: '⯈', justify: '☰' }[a]}
          </Button>
        ))}
      </div>
      <Slider label="Line height" value={o.lineHeight} min={0.7} max={2.5} onChange={(v) => editor.setProps(o, { lineHeight: v }, false)} onCommit={() => editor.changed()} />
      <Slider label="Letter spacing" value={o.charSpacing} min={-100} max={800} step={5} format={(v) => `${v}`} onChange={(v) => editor.setProps(o, { charSpacing: v }, false)} onCommit={() => editor.changed()} />
      <p className="text-[11px] text-stone-500">Tip: double-click the text on the canvas to type directly. Fonts are those available in your browser.</p>
    </Section>
  );
}

function ShapeSection({ o, editor }: { o: Rect | Circle | Triangle; editor: Editor }) {
  return (
    <Section title="Shape">
      <div className="grid grid-cols-2 gap-1.5 text-xs">
        <label className="flex items-center gap-1.5 rounded-md border border-stone-200 px-2 py-1">
          Fill <input type="color" value={toHex(o.fill)} onChange={(e) => editor.setProps(o, { fill: e.target.value }, false)} onBlur={() => editor.changed()} className="h-6 w-full" />
        </label>
        <label className="flex items-center gap-1.5 rounded-md border border-stone-200 px-2 py-1">
          Stroke <input type="color" value={toHex(o.stroke ?? '#000000')} onChange={(e) => editor.setProps(o, { stroke: e.target.value }, false)} onBlur={() => editor.changed()} className="h-6 w-full" />
        </label>
      </div>
      <Slider label="Stroke width" value={o.strokeWidth ?? 0} min={0} max={40} step={1} format={(v) => `${v}px`} onChange={(v) => editor.setProps(o, { strokeWidth: v }, false)} onCommit={() => editor.changed()} />
      {o instanceof Rect && (
        <Slider label="Corner radius" value={o.rx ?? 0} min={0} max={Math.min(o.width, o.height) / 2} step={1} format={(v) => `${v}px`} onChange={(v) => editor.setProps(o, { rx: v, ry: v }, false)} onCommit={() => editor.changed()} />
      )}
    </Section>
  );
}

function ShadowSection({ o, editor }: { o: FabricObject; editor: Editor }) {
  const s = o.shadow instanceof Shadow ? o.shadow : null;
  const [st, setSt] = useState({
    on: !!s, blur: s?.blur ?? 24, offset: s?.offsetX ?? 12, opacity: parseAlpha(s?.color) ?? 0.4, color: '#000000',
  });
  const upd = (patch: Partial<typeof st>) => {
    const n = { ...st, ...patch };
    setSt(n);
    editor.setShadow(o, n);
  };
  return (
    <Section title="Shadow">
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={st.on} onChange={(e) => upd({ on: e.target.checked })} /> Drop shadow
      </label>
      {st.on && (
        <>
          <Slider label="Blur" value={st.blur} min={0} max={80} step={1} format={(v) => `${v}px`} onChange={(v) => setSt({ ...st, blur: v })} onCommit={(v) => upd({ blur: v })} />
          <Slider label="Distance" value={st.offset} min={-60} max={60} step={1} format={(v) => `${v}px`} onChange={(v) => setSt({ ...st, offset: v })} onCommit={(v) => upd({ offset: v })} />
          <Slider label="Opacity" value={st.opacity} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setSt({ ...st, opacity: v })} onCommit={(v) => upd({ opacity: v })} />
        </>
      )}
    </Section>
  );
}

function toHex(v: unknown): string {
  if (typeof v !== 'string') return '#000000';
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + [...v.slice(1)].map((c) => c + c).join('');
  const m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('');
  return '#000000';
}
function parseAlpha(c?: string): number | null {
  const m = c?.match(/rgba\([^)]*,\s*([\d.]+)\)/);
  return m ? parseFloat(m[1]) : null;
}
