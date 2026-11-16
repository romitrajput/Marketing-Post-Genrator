import { useState } from 'react';
import type { Editor, LayerRow } from '../editor/Editor';
import { KIND_COLOR } from '../pages/Analyse';
import { ConfidenceDot } from './ui';

export default function LayerPanel({ editor }: { editor: Editor }) {
  const rows = editor.layers();
  const active = editor.active;
  const [editing, setEditing] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const drop = (target: LayerRow) => {
    const src = rows.find((r) => r.meta.id === dragId);
    setDragId(null);
    setOverId(null);
    if (!src || src === target) return;
    editor.moveTo(src.obj, target.index);
  };

  return (
    <div>
      <ul className="scroll-thin max-h-[40vh] overflow-auto lg:max-h-[34vh]">
        {rows.map((r) => {
          const sel = active === r.obj;
          return (
            <li
              key={r.meta.id}
              draggable={editing !== r.meta.id}
              onDragStart={() => setDragId(r.meta.id)}
              onDragOver={(e) => {
                e.preventDefault();
                setOverId(r.meta.id);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onDrop={() => drop(r)}
              onClick={() => (r.visible ? editor.select(r.obj) : undefined)}
              className={`group flex cursor-pointer items-center gap-1.5 border-l-2 px-2 py-1.5 text-xs ${sel ? 'border-stone-900 bg-stone-100' : 'border-transparent hover:bg-stone-50'} ${overId === r.meta.id && dragId ? 'outline outline-1 outline-amber-500' : ''}`}
            >
              <span className="cursor-grab text-stone-300" title="Drag to reorder">⋮⋮</span>
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: KIND_COLOR[r.meta.kind] ?? '#999' }} title={r.meta.kind} />
              {editing === r.meta.id ? (
                <input
                  autoFocus defaultValue={r.meta.name}
                  className="min-w-0 flex-1 rounded border border-stone-300 px-1"
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    editor.rename(r.obj, e.target.value.trim() || r.meta.name);
                    setEditing(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setEditing(null);
                  }}
                />
              ) : (
                <span
                  className={`min-w-0 flex-1 truncate ${r.visible ? '' : 'text-stone-400 line-through'}`}
                  onDoubleClick={() => setEditing(r.meta.id)} title={`${r.meta.name} — double-click to rename`}
                >
                  {r.meta.name}
                </span>
              )}
              <ConfidenceDot c={r.meta.confidence} />
              <button
                className="w-5 text-center text-stone-500 hover:text-stone-900" title={r.visible ? 'Hide' : 'Show'}
                onClick={(e) => {
                  e.stopPropagation();
                  editor.toggleVisible(r.obj);
                }}
              >
                {r.visible ? '◉' : '○'}
              </button>
              <button
                className={`w-5 text-center ${r.locked ? 'text-stone-900' : 'text-stone-300 hover:text-stone-700'}`} title={r.locked ? 'Unlock' : 'Lock'}
                onClick={(e) => {
                  e.stopPropagation();
                  editor.toggleLock(r.obj);
                }}
              >
                {r.locked ? '🔒' : '🔓'}
              </button>
            </li>
          );
        })}
        {!rows.length && <li className="px-3 py-4 text-center text-xs text-stone-400">No layers</li>}
      </ul>
      {active && (
        <div className="flex flex-wrap gap-1 border-t border-stone-200 px-2 py-2">
          {[
            ['↑', 'Bring forward', () => editor.forward(active)],
            ['↓', 'Send backward', () => editor.backward(active)],
            ['⤒', 'Bring to front', () => editor.toFront(active)],
            ['⤓', 'Send to back', () => editor.toBack(active)],
            ['⧉', 'Duplicate', () => void editor.duplicate(active)],
            ['✎', 'Rename', () => setEditing(rows.find((r) => r.obj === active)?.meta.id ?? null)],
          ].map(([icon, title, fn]) => (
            <button key={title as string} title={title as string} onClick={fn as () => void} className="h-7 w-7 rounded-md text-sm ring-1 ring-stone-300 hover:bg-stone-100">
              {icon as string}
            </button>
          ))}
          <button
            title="Delete layer" disabled={!!rows.find((r) => r.obj === active)?.locked} onClick={() => editor.remove(active)}
            className="ml-auto h-7 rounded-md px-2 text-xs text-red-700 ring-1 ring-red-200 hover:bg-red-50 disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
