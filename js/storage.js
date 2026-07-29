// Minimal IndexedDB wrapper storing finished 360° photos (JPEG blob +
// thumbnail + metadata) so the gallery screen survives app restarts.
const DB_NAME = 'photo360-db';
const STORE = 'photos';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function savePhoto({ name, blob, thumbBlob, width, height }) {
  const db = await openDb();
  const id = `p${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const record = { id, name, blob, thumbBlob, width, height, createdAt: Date.now() };
  await tx(db, 'readwrite', (store) => store.put(record));
  return id;
}

export async function listPhotos() {
  const db = await openDb();
  const items = await tx(db, 'readonly', (store) => store.getAll());
  items.sort((a, b) => b.createdAt - a.createdAt);
  return items;
}

export async function getPhoto(id) {
  const db = await openDb();
  return tx(db, 'readonly', (store) => store.get(id));
}

export async function deletePhoto(id) {
  const db = await openDb();
  await tx(db, 'readwrite', (store) => store.delete(id));
}

export async function renamePhoto(id, name) {
  const db = await openDb();
  const record = await tx(db, 'readonly', (store) => store.get(id));
  if (!record) return;
  record.name = name;
  await tx(db, 'readwrite', (store) => store.put(record));
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
