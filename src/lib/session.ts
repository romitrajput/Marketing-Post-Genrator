import { useSyncExternalStore } from 'react';
import type { Decomposition, SourceImage } from './types';

/** In-memory state shared between pages (upload -> analyse -> studio). */
export interface Session {
  source?: SourceImage;
  decomposition?: Decomposition;
  /** set when the studio should open a saved project */
  openProjectId?: string;
}

let state: Session = {};
const listeners = new Set<() => void>();

export function getSession(): Session {
  return state;
}
export function setSession(patch: Partial<Session>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
export function useSession(): Session {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

// --- hash router ------------------------------------------------------------
export type Route = 'home' | 'upload' | 'analyse' | 'studio' | 'projects';
const ROUTES: Route[] = ['home', 'upload', 'analyse', 'studio', 'projects'];

function parse(): Route {
  const r = location.hash.replace(/^#\/?/, '').split('?')[0] as Route;
  return ROUTES.includes(r) ? r : 'home';
}
export function navigate(r: Route) {
  location.hash = r === 'home' ? '/' : `/${r}`;
}
export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener('hashchange', l);
      return () => window.removeEventListener('hashchange', l);
    },
    parse,
  );
}
