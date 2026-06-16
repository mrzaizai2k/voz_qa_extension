// db.js — IndexedDB persistence layer
// Stores crawled thread data permanently across browser sessions.
// All functions return Promises. Import this from cache.js only.

const DB_NAME    = "voz_qa_db";
const DB_VERSION = 1;
const STORE_NAME = "threads";

// ── Open / init ────────────────────────────────────────────────────────────

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db    = e.target.result;
      const store = db.createObjectStore(STORE_NAME, { keyPath: "thread_id" });
      store.createIndex("crawled_at", "crawled_at", { unique: false });
      console.log("[DB] Schema created / upgraded.");
    };

    req.onsuccess = (e) => {
      _db = e.target.result;
      console.log("[DB] Opened successfully.");
      resolve(_db);
    };

    req.onerror = (e) => {
      console.error("[DB] Open error:", e.target.error);
      reject(e.target.error);
    };
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function withStore(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx    = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);

        tx.onerror   = (e) => reject(e.target.error);
        tx.onabort   = (e) => reject(e.target.error);

        fn(store, resolve, reject);
      })
  );
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Persist a thread data object.
 * @param {object} data  Must contain `thread_id` (string).
 * @returns {Promise<void>}
 */
export function dbSave(data) {
  return withStore("readwrite", (store, resolve, reject) => {
    const req    = store.put(data);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * Load one thread by ID.
 * @param {string} threadId
 * @returns {Promise<object|null>}  null if not found.
 */
export function dbLoad(threadId) {
  return withStore("readonly", (store, resolve, reject) => {
    const req     = store.get(threadId);
    req.onsuccess = (e) => resolve(e.target.result ?? null);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * Delete one thread by ID.
 * @param {string} threadId
 * @returns {Promise<void>}
 */
export function dbDelete(threadId) {
  return withStore("readwrite", (store, resolve, reject) => {
    const req     = store.delete(threadId);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * List metadata for all stored threads (no posts array — lightweight).
 * @returns {Promise<Array<{thread_id, title, url, crawled_at, post_count, total_pages}>>}
 */
export function dbListAll() {
  return withStore("readonly", (store, resolve, reject) => {
    const results = [];
    const req     = store.openCursor();

    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const { thread_id, title, url, crawled_at, post_count, total_pages } = cursor.value;
        results.push({ thread_id, title, url, crawled_at, post_count, total_pages });
        cursor.continue();
      } else {
        resolve(results);
      }
    };

    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Clear every thread from the DB.
 * @returns {Promise<void>}
 */
export function dbClearAll() {
  return withStore("readwrite", (store, resolve, reject) => {
    const req     = store.clear();
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}