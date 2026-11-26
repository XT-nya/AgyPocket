import type { SessionDetail } from '../api/client';

const DB_NAME = 'agypocket-cache-v1';
const STORE_NAME = 'sessions';
const FALLBACK_KEY = 'agypocket-sessions-fallback-v1';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

function readFallbackMap(): Record<string, SessionDetail> {
  try {
    const raw = localStorage.getItem(FALLBACK_KEY);
    return raw ? (JSON.parse(raw) as Record<string, SessionDetail>) : {};
  } catch {
    return {};
  }
}

function writeFallbackMap(map: Record<string, SessionDetail>) {
  try {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(map));
  } catch {
    // ignore quota exceeded
  }
}

export async function getAllCachedSessions(): Promise<SessionDetail[]> {
  try {
    const db = await openDb();
    return await new Promise<SessionDetail[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve((req.result as SessionDetail[]) || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return Object.values(readFallbackMap());
  }
}

export async function getCachedSession(id: string): Promise<SessionDetail | null> {
  try {
    const db = await openDb();
    return await new Promise<SessionDetail | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve((req.result as SessionDetail) || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return readFallbackMap()[id] || null;
  }
}

export async function putCachedSessions(sessions: SessionDetail[]): Promise<void> {
  if (!sessions.length) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const s of sessions) {
        store.put(s);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    const map = readFallbackMap();
    for (const s of sessions) map[s.id] = s;
    writeFallbackMap(map);
  }
}

export async function putCachedSession(session: SessionDetail): Promise<void> {
  return putCachedSessions([session]);
}

export async function removeCachedSession(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    const map = readFallbackMap();
    delete map[id];
    writeFallbackMap(map);
  }
}

export async function getCachedFingerprintMap(): Promise<Record<string, string>> {
  const all = await getAllCachedSessions();
  const fpMap: Record<string, string> = {};
  for (const s of all) {
    if (s.agy_conversation_id && s.sync_fingerprint) {
      fpMap[s.agy_conversation_id] = s.sync_fingerprint;
    }
  }
  return fpMap;
}
