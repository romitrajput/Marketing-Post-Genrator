import { FabricImage, type FabricObject } from 'fabric';
import { useCallback, useEffect, useRef, useState } from 'react';
import ExportDialog from '../components/ExportDialog';
import LayerPanel from '../components/LayerPanel';
import MaskEditor, { type MaskResult } from '../components/MaskEditor';
import PropertiesPanel, { type LayerActions } from '../components/PropertiesPanel';
import { Button, ErrorBox, Logo, Modal, Section, Spinner, pickFile } from '../components/ui';
import { Editor, metaOf } from '../editor/Editor';
import { cvInpaint } from '../lib/cvClient';
import { requestPersistence } from '../lib/db';
import {
  MAX_PROCESS_SIDE, cutout, downloadBlob, eraseMask, imageDataToUrl, readSource, resizeBlob, safeFileName, urlToImageData, validateFile,
} from '../lib/image';
import { loadProject, saveProject } from '../lib/project';
import { urlStats } from '../lib/raster';
import { navigate, setSession, useSession } from '../lib/session';
import type { SourceImage } from '../lib/types';

interface MaskJob {
  title: string;
  sourceUrl: string;
  initialMask?: Uint8Array | null;
  autoDetect?: boolean;
  applyLabel: string;
  option?: { label: string; initial: boolean };
  hint?: string;
  onApply: (r: MaskResult) => Promise<void>;
}

const CANVAS_PRESETS: [string, number, number][] = [
  ['1080 × 1080', 1080, 1080],
  ['1080 × 1350', 1080, 1350],
  ['1080 × 1920', 1080, 1920],
];

export default function StudioPage() {
  const session = useSession();
  const hostRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [, setTick] = useState(0);
  const [loading, setLoading] = useState<string | null>('Preparing editor…');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [original, setOriginal] = useState<SourceImage | null>(null);
  const [projectId, setProjectId] = useState<string | undefined>();
  const [name, setName] = useState('Untitled remix');
  const [initialJson, setInitialJson] = useState<string | undefined>();
  const [savedVersion, setSavedVersion] = useState(0);
  const [maskJob, setMaskJob] = useState<MaskJob | null>(null);
  const [replaceFor, setReplaceFor] = useState<{ obj: FabricObject; src: SourceImage } | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [bgColor, setBgColor] = useState('#ffffff');
  const [hand, setHand] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'tools' | 'layers' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // ------------------------------------------------------------ init
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ed = new Editor(host);
    const unsub = ed.subscribe(() => setTick((t) => t + 1));
    setEditor(ed);
    (async () => {
      try {
        if (session.openProjectId) {
          setLoading('Opening project…');
          const p = await loadProject(session.openProjectId);
          await ed.loadJSON(p.json);
          setProjectId(p.meta.id);
          setName(p.meta.name);
          setInitialJson(p.initialJson);
          if (p.original) setOriginal(await readSource(p.original, p.originalName ?? 'original'));
          setSession({ openProjectId: undefined });
        } else if (session.decomposition && session.source) {
          setLoading('Building layers…');
          await ed.loadDecomposition(session.decomposition);
          setInitialJson(ed.toJSON());
          setOriginal(session.source);
          setName(session.source.name.replace(/\.[a-z]+$/i, '') + ' remix');
        }
        setSavedVersion(ed.version);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(null);
      }
    })();
    return () => {
      unsub();
      ed.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = !!editor && editor.version !== savedVersion;
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const guard = useCallback(async (label: string, fn: () => Promise<void> | void) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? null : n)), 5000);
  };

  // ------------------------------------------------------------ helpers
  const fileToSource = async (f: File): Promise<SourceImage> => {
    const v = validateFile(f);
    if (v) throw new Error(v);
    let s = await readSource(f, f.name);
    if (Math.max(s.width, s.height) > MAX_PROCESS_SIDE) s = await readSource(await resizeBlob(s, MAX_PROCESS_SIDE), f.name);
    return s;
  };

  const backgroundLayer = (ed: Editor) =>
    ed.layers().map((r) => r.obj).find((o) => o instanceof FabricImage && metaOf(o).kind === 'background' && o.visible && metaOf(o).origBox?.x === 0 && metaOf(o).origBox?.y === 0) as FabricImage | undefined;

  // ------------------------------------------------------------ selection tools
  const selectFromOriginal = () => {
    if (!editor || !original) return;
    let n = editor.layers().filter((r) => r.meta.name.startsWith('Selection')).length;
    setMaskJob({
      title: 'Select an object from the original image',
      sourceUrl: original.url,
      applyLabel: 'Extract as new layer',
      option: backgroundLayer(editor) ? { label: 'Also remove it from the background (fill the hole)', initial: false } : undefined,
      hint: 'Paint or outline the object, use “Snap to edges” to tighten the selection, then extract it.',
      onApply: async (r) => {
        const c = await cutout(r.source, r.mask);
        if (!c) throw new Error('The selection is empty.');
        const img = await editor.addImage(c.url, `Selection ${++n}`, 'object', { box: c.box });
        const m = metaOf(img);
        m.confidence = 'manual';
        m.note = 'Extracted with manual selection. Use “Refine mask” to adjust.';
        if (r.option) {
          const bg = backgroundLayer(editor);
          const bm = bg && metaOf(bg);
          if (bg && bm?.baseSrc) {
            const data = await urlToImageData(bm.baseSrc);
            if (data.width === r.width && data.height === r.height) {
              const filled = await cvInpaint(data, r.mask);
              await editor.setCutout(bg, await imageDataToUrl(filled.data), 0, 0);
            }
          }
        }
        editor.commit();
        setMaskJob(null);
      },
    });
  };

  const selectFromLayer = () => {
    const o = editor?.active;
    if (!editor || !(o instanceof FabricImage)) return;
    const el = o.getElement() as HTMLImageElement;
    setMaskJob({
      title: `Select from layer “${metaOf(o).name}”`,
      sourceUrl: el.src,
      applyLabel: 'Extract as new layer',
      option: { label: 'Remove the selection from the source layer', initial: false },
      onApply: async (r) => {
        const c = await cutout(r.source, r.mask);
        if (!c) throw new Error('The selection is empty.');
        await editor.addFromLayer(o, c.url, c.box, `${metaOf(o).name} – part`);
        if (r.option) {
          const m = metaOf(o);
          m.feather = 0;
          m.colorMatch = null;
          await editor.setCutout(o, await imageDataToUrl(eraseMask(r.source, r.mask)), 0, 0);
        }
        editor.commit();
        setMaskJob(null);
      },
    });
  };

  // ------------------------------------------------------------ layer actions
  const actions: LayerActions = {
    canRefine: (o) => {
      const m = metaOf(o);
      return !!original && o instanceof FabricImage && !!m.origBox && !!m.baseSrc && !['background', 'original'].includes(m.kind);
    },
    refine: (o) => {
      if (!editor || !original || !(o instanceof FabricImage)) return;
      const m = metaOf(o);
      if (!m.origBox || !m.baseSrc) return;
      void guard('Preparing mask…', async () => {
        const layer = await urlToImageData(m.baseSrc!);
        const full = new Uint8Array(original.width * original.height);
        const b = m.origBox!;
        for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) {
          const fx = b.x + x, fy = b.y + y;
          if (fx < 0 || fy < 0 || fx >= original.width || fy >= original.height) continue;
          full[fy * original.width + fx] = layer.data[(y * layer.width + x) * 4 + 3];
        }
        setMaskJob({
          title: `Refine mask — ${m.name}`,
          sourceUrl: original.url,
          initialMask: full,
          applyLabel: 'Apply to layer',
          hint: 'Brush adds, eraser removes. The layer keeps its position, size and effects.',
          onApply: async (r) => {
            const c = await cutout(r.source, r.mask);
            if (!c) throw new Error('The selection is empty.');
            await editor.setCutout(o, c.url, c.box.x - b.x, c.box.y - b.y, c.box);
            m.confidence = 'high';
            m.note = 'Mask corrected manually.';
            editor.commit();
            setMaskJob(null);
          },
        });
      });
    },
    removeBackground: (o) => {
      if (!editor || !(o instanceof FabricImage)) return;
      const m = metaOf(o);
      const srcUrl = m.baseSrc ?? (o.getElement() as HTMLImageElement).src;
      setMaskJob({
        title: `Remove background — ${m.name}`,
        sourceUrl: srcUrl,
        autoDetect: true,
        applyLabel: 'Keep selection, remove the rest',
        hint: 'The object was detected automatically (GrabCut). Correct it with the brush/eraser if needed.',
        onApply: async (r) => {
          const c = await cutout(r.source, r.mask);
          if (!c) throw new Error('The selection is empty.');
          const nb = m.origBox ? { x: m.origBox.x + c.box.x, y: m.origBox.y + c.box.y, w: c.box.w, h: c.box.h } : undefined;
          await editor.setCutout(o, c.url, c.box.x, c.box.y, nb);
          if (m.kind === 'image') m.kind = 'object';
          editor.commit();
          setMaskJob(null);
        },
      });
    },
    replace: (o) => {
      void guard('Loading replacement…', async () => {
        const f = await pickFile();
        if (!f) return;
        setReplaceFor({ obj: o, src: await fileToSource(f) });
      });
    },
    exportLayer: (o) => {
      if (!editor) return;
      void guard('Exporting layer…', async () => {
        downloadBlob(await editor.exportLayer(o), `${safeFileName(name)}-${safeFileName(metaOf(o).name)}.png`);
      });
    },
  };

  const finishReplace = async (o: FabricObject, url: string) => {
    if (!editor) return;
    const m = metaOf(o);
    if (m.kind === 'background') {
      await editor.setBackgroundImage(url);
      return;
    }
    const oldSrc = m.baseSrc ?? (o instanceof FabricImage ? (o.getElement() as HTMLImageElement).src : undefined);
    const stats = oldSrc ? await urlStats(oldSrc).catch(() => null) : null;
    const img = await editor.replaceImage(o, url);
    metaOf(img).matchTarget = stats;
    flash('Replaced. Adjust position and size freely; try “Match colours” and a drop shadow in the right panel.');
  };

  const replaceWith = (mode: 'auto' | 'manual' | 'whole') => {
    if (!replaceFor || !editor) return;
    const { obj, src } = replaceFor;
    setReplaceFor(null);
    if (mode === 'whole') {
      void guard('Replacing…', () => finishReplace(obj, src.url));
      return;
    }
    setMaskJob({
      title: 'Cut out the replacement',
      sourceUrl: src.url,
      autoDetect: mode === 'auto',
      applyLabel: 'Use this cut-out',
      hint: mode === 'auto' ? 'Foreground detected automatically. Fix any mistakes, then continue.' : 'Paint or outline the part to use.',
      onApply: async (r) => {
        const c = await cutout(r.source, r.mask);
        if (!c) throw new Error('The selection is empty.');
        await finishReplace(obj, c.url);
        setMaskJob(null);
      },
    });
  };

  // ------------------------------------------------------------ top bar actions
  const save = () =>
    guard('Saving…', async () => {
      if (!editor) return;
      const id = await saveProject({
        id: projectId, name, json: editor.toJSON(), initialJson, docW: editor.docW, docH: editor.docH,
        layerCount: editor.layers().length, thumb: await editor.thumbnail(), original: original?.blob, originalName: original?.name,
      });
      setProjectId(id);
      setSavedVersion(editor.version);
      void requestPersistence();
      flash('Saved in this browser. Clearing browser data or switching device will lose it — export your final image.');
    });

  const reset = () => {
    if (!editor || !initialJson) return;
    if (!window.confirm('Reset all edits back to the state right after decomposition?')) return;
    void guard('Resetting…', async () => {
      await editor.loadJSON(initialJson, false);
      editor.commit();
    });
  };

  const openPreview = () => {
    if (!editor) return;
    const scale = Math.min(1, 1600 / Math.max(editor.docW, editor.docH));
    setPreview(editor.renderDoc(scale).toDataURL('image/png'));
  };

  const addImage = () =>
    guard('Adding image…', async () => {
      const f = await pickFile();
      if (!f || !editor) return;
      const s = await fileToSource(f);
      await editor.addImage(s.url, f.name.replace(/\.[a-z]+$/i, ''), 'image');
    });

  const bgImage = () =>
    guard('Setting background…', async () => {
      const f = await pickFile();
      if (!f || !editor) return;
      const s = await fileToSource(f);
      await editor.setBackgroundImage(s.url);
    });

  // ------------------------------------------------------------ render
  const empty = !loading && editor && editor.layers().length === 0;
  const active = editor?.active;
  const tools = editor && (
    <div>
      <Section title="Add">
        <div className="grid grid-cols-2 gap-1.5">
          <Button size="sm" onClick={addImage}>Image</Button>
          <Button size="sm" onClick={() => editor.addText()}>Text</Button>
          <Button size="sm" onClick={() => editor.addShape('rect')}>Rectangle</Button>
          <Button size="sm" onClick={() => editor.addShape('circle')}>Circle</Button>
          <Button size="sm" onClick={() => editor.addShape('triangle')}>Triangle</Button>
          <Button size="sm" onClick={() => navigate('upload')} title="Start over with a different image">New image</Button>
        </div>
      </Section>
      <Section title="Object selection">
        <Button size="sm" className="w-full" disabled={!original} onClick={selectFromOriginal}>Select from original image…</Button>
        <Button size="sm" className="w-full" disabled={!(active instanceof FabricImage)} onClick={selectFromLayer}>Select from selected layer…</Button>
        <p className="text-[11px] text-stone-500">Rectangle, polygon, brush, eraser, invert and edge snapping. The result becomes a transparent PNG layer.</p>
      </Section>
      <Section title="Background">
        <div className="flex items-center gap-1.5">
          <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} className="h-8 w-10 rounded border border-stone-300" />
          <Button size="sm" className="flex-1" onClick={() => editor.setBackgroundColor(bgColor)}>Fill with colour</Button>
        </div>
        <Button size="sm" className="w-full" onClick={bgImage}>Use an image…</Button>
        <Button size="sm" className="w-full" onClick={() => editor.setTransparentBackground()}>Make transparent</Button>
        <p className="text-[11px] text-stone-500">Replacing hides the reconstructed background layer (you can show it again in Layers).</p>
      </Section>
      <Section title="Canvas size">
        <div className="grid grid-cols-3 gap-1">
          {CANVAS_PRESETS.map(([l, w, h]) => (
            <Button key={l} size="sm" className="px-1 text-[11px]" variant={editor.docW === w && editor.docH === h ? 'primary' : 'secondary'} onClick={() => editor.resizeDoc(w, h)}>{l}</Button>
          ))}
        </div>
        <p className="text-[11px] text-stone-500">Currently {editor.docW} × {editor.docH}px. Changing keeps layers centred; refill the background afterwards.</p>
      </Section>
    </div>
  );

  return (
    <div className="flex h-full flex-col bg-stone-100">
      {/* top bar */}
      <header className="flex flex-wrap items-center gap-2 border-b border-stone-200 bg-white px-3 py-2">
        <Logo />
        <input
          value={name} onChange={(e) => setName(e.target.value)}
          className="w-40 rounded-md border border-transparent px-2 py-1 text-sm font-medium hover:border-stone-300 focus:border-stone-400 sm:w-56"
          aria-label="Project name"
        />
        {dirty && <span className="text-[11px] text-amber-700">unsaved</span>}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button size="sm" variant="ghost" disabled={!editor?.canUndo} onClick={() => editor?.undo()} title="Undo (Ctrl+Z)">↶ Undo</Button>
          <Button size="sm" variant="ghost" disabled={!editor?.canRedo} onClick={() => editor?.redo()} title="Redo (Ctrl+Shift+Z)">↷ Redo</Button>
          <Button size="sm" variant="ghost" disabled={!initialJson} onClick={reset} title="Back to the decomposed state">Reset</Button>
          <span className="mx-1 hidden h-5 w-px bg-stone-200 sm:block" />
          <Button size="sm" variant="ghost" onClick={() => editor?.zoomBy(1 / 1.25)} title="Zoom out">−</Button>
          <button className="w-12 text-center text-xs tabular-nums text-stone-600" onClick={() => editor?.fit()} title="Fit to screen">{Math.round((editor?.zoom ?? 1) * 100)}%</button>
          <Button size="sm" variant="ghost" onClick={() => editor?.zoomBy(1.25)} title="Zoom in">+</Button>
          <Button size="sm" variant={hand ? 'primary' : 'ghost'} onClick={() => { editor?.setHandMode(!hand); setHand(!hand); }} title="Pan (or hold Space)">✋</Button>
          <span className="mx-1 hidden h-5 w-px bg-stone-200 sm:block" />
          <Button size="sm" onClick={openPreview}>Preview</Button>
          <Button size="sm" onClick={save} disabled={!editor || !!busy}>Save</Button>
          <Button size="sm" variant="primary" onClick={() => setShowExport(true)} disabled={!editor}>Export</Button>
        </div>
      </header>
      {(error || notice || busy) && (
        <div className="space-y-1 border-b border-stone-200 bg-white px-3 py-1.5">
          {error && <ErrorBox>{error}</ErrorBox>}
          {notice && <div className="text-xs text-emerald-800">{notice}</div>}
          {busy && <div className="flex items-center gap-2 text-xs text-stone-600"><Spinner className="h-3 w-3" /> {busy}</div>}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="scroll-thin hidden w-60 shrink-0 overflow-auto border-r border-stone-200 bg-white lg:block">{tools}</aside>

        <div className="relative min-h-[55vh] flex-1 lg:min-h-0">
          <div ref={hostRef} className="absolute inset-0 overflow-hidden bg-stone-200" style={{ touchAction: 'none' }} />
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center"><div className="flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm shadow"><Spinner /> {loading}</div></div>
          )}
          {empty && (
            <div className="absolute inset-0 flex items-center justify-center p-4">
              <div className="max-w-sm rounded-2xl bg-white p-6 text-center shadow">
                <p className="mb-4 text-stone-600">Nothing to edit yet. Upload an image or open a saved project.</p>
                <div className="flex justify-center gap-2">
                  <Button variant="primary" onClick={() => navigate('upload')}>Upload image</Button>
                  <Button onClick={() => navigate('projects')}>Projects</Button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* mobile panel switcher */}
        <div className="flex border-t border-stone-200 bg-white lg:hidden">
          {(['tools', 'layers'] as const).map((p) => (
            <button key={p} onClick={() => setMobilePanel(mobilePanel === p ? null : p)} className={`flex-1 py-2 text-sm font-medium ${mobilePanel === p ? 'bg-stone-900 text-white' : ''}`}>
              {p === 'tools' ? 'Tools' : 'Layers & properties'}
            </button>
          ))}
        </div>
        {mobilePanel === 'tools' && <div className="max-h-[45vh] overflow-auto bg-white lg:hidden">{tools}</div>}

        <aside className={`scroll-thin w-full shrink-0 overflow-auto border-l border-stone-200 bg-white lg:block lg:w-72 ${mobilePanel === 'layers' ? 'max-h-[45vh]' : 'hidden'}`}>
          {editor && (
            <>
              <Section title="Layers"><LayerPanel editor={editor} /></Section>
              <PropertiesPanel editor={editor} actions={actions} />
            </>
          )}
        </aside>
      </div>

      {maskJob && (
        <MaskEditor
          key={maskJob.sourceUrl + maskJob.title}
          {...maskJob}
          onCancel={() => setMaskJob(null)}
          onApply={maskJob.onApply}
        />
      )}
      {replaceFor && (
        <Modal title="Replace layer" onClose={() => setReplaceFor(null)}>
          <div className="space-y-3 p-4 text-sm">
            <div className="checker mx-auto flex h-40 items-center justify-center rounded-lg"><img src={replaceFor.src.url} alt="" className="max-h-40 max-w-full" /></div>
            <p className="text-stone-600">How should the new image be used? It will be placed where “{metaOf(replaceFor.obj).name}” is, at the same size.</p>
            <div className="grid gap-2">
              <Button variant="primary" onClick={() => replaceWith('auto')}>Remove its background automatically</Button>
              <Button onClick={() => replaceWith('manual')}>Select the part to use manually</Button>
              <Button onClick={() => replaceWith('whole')}>Use the whole image</Button>
            </div>
          </div>
        </Modal>
      )}
      {showExport && editor && <ExportDialog editor={editor} name={name} onClose={() => setShowExport(false)} />}
      {preview && (
        <Modal title="Preview" wide onClose={() => setPreview(null)}>
          <div className="checker flex h-full items-center justify-center p-4"><img src={preview} alt="Preview" className="max-h-full max-w-full object-contain shadow-lg" /></div>
        </Modal>
      )}
    </div>
  );
}
