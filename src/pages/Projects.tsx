import { useEffect, useState } from 'react';
import { Button, ErrorBox, Spinner, TopNav } from '../components/ui';
import { deleteProject, listProjects, renameProject, storageEstimate, type ProjectMeta } from '../lib/db';
import { navigate, setSession } from '../lib/session';

export default function ProjectsPage() {
  const [items, setItems] = useState<(ProjectMeta & { thumbUrl: string })[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [usage, setUsage] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const load = async () => {
    setErr(null);
    try {
      const list = await listProjects();
      setItems((prev) => {
        prev?.forEach((p) => URL.revokeObjectURL(p.thumbUrl));
        return list.map((p) => ({ ...p, thumbUrl: URL.createObjectURL(p.thumb) }));
      });
      setUsage(await storageEstimate());
    } catch (e) {
      setErr((e as Error).message);
      setItems([]);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const open = (id: string) => {
    setSession({ openProjectId: id, decomposition: undefined });
    navigate('studio');
  };
  const remove = async (p: ProjectMeta) => {
    if (!window.confirm(`Delete “${p.name}”? This cannot be undone.`)) return;
    try {
      await deleteProject(p.id);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const rename = async (id: string, name: string) => {
    setRenaming(null);
    if (!name.trim()) return;
    try {
      await renameProject(id, name.trim());
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="min-h-full">
      <TopNav />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Saved projects</h1>
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Projects are stored only in this browser (IndexedDB). They are lost if you clear browsing data, use private mode, or
          switch device/browser. Export finished images to keep them.
          {usage && <div className="mt-0.5 text-xs text-amber-800">{usage}</div>}
        </div>
        {err && <div className="mt-4"><ErrorBox onRetry={load}>{err}</ErrorBox></div>}
        {!items && <div className="mt-10 flex justify-center"><Spinner /></div>}
        {items && items.length === 0 && !err && (
          <div className="mt-10 text-center text-stone-600">
            No saved projects yet.
            <div className="mt-3"><Button variant="primary" onClick={() => navigate('upload')}>Start with an image</Button></div>
          </div>
        )}
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {items?.map((p) => (
            <div key={p.id} className="overflow-hidden rounded-xl border border-stone-200 bg-white">
              <button onClick={() => open(p.id)} className="checker block w-full">
                <img src={p.thumbUrl} alt="" className="aspect-[4/5] w-full object-contain" />
              </button>
              <div className="space-y-1 p-3">
                {renaming === p.id ? (
                  <input
                    autoFocus defaultValue={p.name} className="w-full rounded border border-stone-300 px-1.5 py-0.5 text-sm"
                    onBlur={(e) => rename(p.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                ) : (
                  <div className="truncate text-sm font-medium" title={p.name}>{p.name}</div>
                )}
                <div className="text-xs text-stone-500">
                  {p.docW}×{p.docH} · {p.layerCount} layers · {new Date(p.updatedAt).toLocaleString()}
                </div>
                <div className="flex gap-1 pt-1">
                  <Button size="sm" variant="primary" className="flex-1" onClick={() => open(p.id)}>Open</Button>
                  <Button size="sm" onClick={() => setRenaming(p.id)}>Rename</Button>
                  <Button size="sm" variant="danger" onClick={() => remove(p)}>Delete</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
