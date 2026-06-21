import { hanaFetch } from '../hooks/use-hana-fetch';

export type ResourceRef =
  | { kind: 'local-file'; path: string }
  | { kind: 'mount'; mountId: string; path: string };

type WatchEntry = {
  refCount: number;
  subscriptionId: string | null;
  disposed: boolean;
  released: boolean;
  ready: Promise<void>;
};

const watches = new Map<string, WatchEntry>();

function normalizeResourceRef(ref: ResourceRef): ResourceRef {
  if (ref.kind === 'local-file') {
    return { kind: 'local-file', path: ref.path };
  }
  return {
    kind: 'mount',
    mountId: ref.mountId,
    path: String(ref.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
  };
}

export function resourceWatchKey(ref: ResourceRef): string {
  const normalized = normalizeResourceRef(ref);
  if (normalized.kind === 'local-file') {
    const slashed = normalized.path.replace(/\\/g, '/').replace(/\/+$/g, '');
    return `local-file:${/^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed}`;
  }
  return `mount:${normalized.mountId}:${normalized.path}`;
}

export function retainResourceWatch(ref: ResourceRef): () => void {
  const normalizedRef = normalizeResourceRef(ref);
  const key = resourceWatchKey(normalizedRef);
  const existing = watches.get(key);
  if (existing) {
    existing.refCount += 1;
    return () => releaseResourceWatch(key);
  }

  const entry: WatchEntry = {
    refCount: 1,
    subscriptionId: null,
    disposed: false,
    released: false,
    ready: Promise.resolve(),
  };
  entry.ready = hanaFetch('/api/resource-io/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose: 'resource-watch', resources: [normalizedRef] }),
    throwOnHttpError: false,
  })
    .then(res => res.json())
    .then((data) => {
      if (typeof data?.subscriptionId === 'string') entry.subscriptionId = data.subscriptionId;
      else console.warn('[resource-events] watch failed:', data?.error || ref);
      if (entry.disposed) releaseEntry(entry);
    })
    .catch((err) => {
      if (!entry.disposed) console.warn('[resource-events] watch failed:', err);
    });
  watches.set(key, entry);
  return () => releaseResourceWatch(key);
}

export function retainLocalFileResourceWatch(filePath: string): () => void {
  return retainResourceWatch({ kind: 'local-file', path: filePath });
}

function releaseResourceWatch(key: string): void {
  const entry = watches.get(key);
  if (!entry) return;
  if (entry.refCount > 1) {
    entry.refCount -= 1;
    return;
  }
  watches.delete(key);
  entry.disposed = true;
  void entry.ready.then(() => releaseEntry(entry));
}

function releaseEntry(entry: WatchEntry): void {
  if (entry.released || !entry.subscriptionId) return;
  entry.released = true;
  void hanaFetch(`/api/resource-io/subscriptions/${encodeURIComponent(entry.subscriptionId)}`, {
    method: 'DELETE',
    throwOnHttpError: false,
  }).catch((err) => {
    console.warn('[resource-events] unwatch failed:', err);
  });
}
