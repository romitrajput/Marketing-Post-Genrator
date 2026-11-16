import { getProjectData, getProjectMeta, putProject, type ProjectMeta } from './db';
import { uid } from './image';

const BLOB_RE = /blob:[^"\\\s)]+/g;
const ASSET_RE = /asset:[a-z0-9_]+/g;

/** Replace every blob: URL in the given JSON strings with an asset id, collecting the blobs. */
async function extractAssets(jsons: string[]): Promise<{ out: string[]; assets: Record<string, Blob> }> {
  const urls = new Set<string>();
  jsons.forEach((j) => j.match(BLOB_RE)?.forEach((u) => urls.add(u)));
  const map = new Map<string, string>();
  const assets: Record<string, Blob> = {};
  let i = 0;
  for (const u of urls) {
    const res = await fetch(u);
    if (!res.ok) throw new Error('An image of this project is no longer in memory; reload and try again.');
    const key = `asset:${(i++).toString(36)}`;
    assets[key] = await res.blob();
    map.set(u, key);
  }
  return { out: jsons.map((j) => j.replace(BLOB_RE, (u) => map.get(u) ?? u)), assets };
}

export async function saveProject(args: {
  id?: string;
  name: string;
  json: string;
  initialJson?: string;
  docW: number;
  docH: number;
  layerCount: number;
  thumb: Blob;
  original?: Blob;
  originalName?: string;
}): Promise<string> {
  const id = args.id ?? uid('p');
  const prev = args.id ? await getProjectMeta(args.id) : undefined;
  const { out, assets } = await extractAssets([args.json, args.initialJson ?? '']);
  const meta: ProjectMeta = {
    id, name: args.name, createdAt: prev?.createdAt ?? Date.now(), updatedAt: Date.now(),
    docW: args.docW, docH: args.docH, layerCount: args.layerCount, thumb: args.thumb,
  };
  await putProject(meta, {
    id, json: out[0], initialJson: out[1] || undefined, assets, original: args.original, originalName: args.originalName,
  });
  return id;
}

export async function loadProject(id: string) {
  const [meta, data] = await Promise.all([getProjectMeta(id), getProjectData(id)]);
  if (!meta || !data) throw new Error('Project not found in this browser.');
  const urls: Record<string, string> = {};
  for (const [k, b] of Object.entries(data.assets)) urls[k] = URL.createObjectURL(b);
  const restore = (j?: string) => j?.replace(ASSET_RE, (k) => urls[k] ?? k);
  return { meta, json: restore(data.json)!, initialJson: restore(data.initialJson), original: data.original, originalName: data.originalName };
}
