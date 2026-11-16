/* Tiny IndexedDB wrapper (no dependency). Everything stays in this browser. */

const DB_NAME = 'remix-studio';
const DB_VERSION = 1;

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  docW: number;
  docH: number;
  layerCount: number;
  thumb: Blob;
}

export interface ProjectData {
  id: string;
  json: string; // Fabric canvas JSON with asset placeholders
  initialJson?: string; // state right after decomposition (for Reset)
  assets: Record<string, Blob>;
  original?: Blob;
  originalName?: string;
}

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!('indexedDB' in window)) return Promise.reject(new Error('This browser has no IndexedDB; projects cannot be saved.'));
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbp = null;
        reject(req.error ?? new Error('Could not open IndexedDB (private mode?).'));
      };
    });
  }
  return dbp;
}

function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = db.transaction(stores, mode);
        let result: T | undefined;
        const req = fn(t);
        if (req) req.onsuccess = () => (result = req.result);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'));
        t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted (storage full?)'));
      }),
  );
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const all = (await tx<ProjectMeta[]>(['meta'], 'readonly', (t) => t.objectStore('meta').getAll())) ?? [];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getProjectMeta(id: string) {
  return tx<ProjectMeta>(['meta'], 'readonly', (t) => t.objectStore('meta').get(id));
}
export function getProjectData(id: string) {
  return tx<ProjectData>(['data'], 'readonly', (t) => t.objectStore('data').get(id));
}

export function putProject(meta: ProjectMeta, data: ProjectData) {
  return tx(['meta', 'data'], 'readwrite', (t) => {
    t.objectStore('meta').put(meta);
    t.objectStore('data').put(data);
  });
}

export async function renameProject(id: string, name: string) {
  const m = await getProjectMeta(id);
  if (!m) throw new Error('Project not found');
  await tx(['meta'], 'readwrite', (t) => {
    t.objectStore('meta').put({ ...m, name, updatedAt: Date.now() });
  });
}

export function deleteProject(id: string) {
  return tx(['meta', 'data'], 'readwrite', (t) => {
    t.objectStore('meta').delete(id);
    t.objectStore('data').delete(id);
  });
}

export async function storageEstimate(): Promise<string | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e || !e.quota) return null;
    return `${((e.usage ?? 0) / 1048576).toFixed(1)} MB used of ~${(e.quota / 1048576).toFixed(0)} MB available to this site`;
  } catch {
    return null;
  }
}

/** Ask the browser not to evict our data under storage pressure (best effort). */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
