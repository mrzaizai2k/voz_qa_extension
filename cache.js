// cache.js — Hybrid store: RAM (recently used) + IndexedDB (permanent)
//
// Strategy:
//   • RAM Map  → instant access for threads touched this session
//   • IndexedDB → survives browser close; source of truth
//
// On get():  check RAM first → fall back to DB (warm RAM on hit)
// On save(): write RAM immediately + DB asynchronously
// On clear(): evict from both

import { dbSave, dbLoad, dbDelete, dbListAll, dbClearAll } from "./db.js";

// ── RAM layer ──────────────────────────────────────────────────────────────
// Simple Map. In a service worker this lives until the SW is killed.
const ram = new Map(); // threadId → data

// ── Core API ───────────────────────────────────────────────────────────────

/**
 * Retrieve a thread. Checks RAM first, then IndexedDB.
 * Warms RAM on a DB hit so the next call is instant.
 *
 * @param {string} threadId
 * @returns {Promise<object|null>}
 */
export async function cacheGet(threadId) {
  if (ram.has(threadId)) {
    console.log("[Cache] RAM hit:", threadId);
    return ram.get(threadId);
  }

  const data = await dbLoad(threadId);
  if (data) {
    console.log("[Cache] DB hit (warming RAM):", threadId);
    ram.set(threadId, data);
  } else {
    console.log("[Cache] Miss:", threadId);
  }
  return data ?? null;
}

/**
 * Save a thread. Writes to RAM immediately and persists to DB in the background.
 *
 * @param {object} data  Must contain `thread_id`.
 * @returns {Promise<void>}  Resolves when DB write completes.
 */
export async function cacheSave(data) {
    const { thread_id } = data;
    ram.set(thread_id, data);                    // synchronous RAM write
    await dbSave(data);                          // await DB so caller knows it's durable
    console.log("[Cache] Saved:", thread_id, `(${data.post_count} posts)`);
}

/**
 * Evict a thread from RAM and IndexedDB.
 *
 * @param {string} threadId
 */
export async function cacheClear(threadId) {
  ram.delete(threadId);
  await dbDelete(threadId);
  console.log("[Cache] Cleared:", threadId);
}

/**
 * Evict ALL threads from RAM and IndexedDB.
 */
export async function cacheClearAll() {
  ram.clear();
  await dbClearAll();
  console.log("[Cache] All cleared.");
}

// ── Metadata helpers (no posts array — fast) ───────────────────────────────

/**
 * Returns lightweight info about one thread if it exists anywhere.
 * Does NOT load posts into RAM.
 *
 * @param {string} threadId
 * @returns {Promise<{cached:true, title, post_count, crawled_at}|{cached:false}>}
 */
export async function cacheInfo(threadId) {
  // Check RAM first (already full object)
  if (ram.has(threadId)) {
    const { title, post_count, crawled_at } = ram.get(threadId);
    return { cached: true, title, post_count, crawled_at };
  }

  // Check DB without loading posts (dbLoad fetches full object but we just peek)
  const data = await dbLoad(threadId);
  if (data) {
    const { title, post_count, crawled_at } = data;
    // Don't warm RAM here — caller only wants metadata
    return { cached: true, title, post_count, crawled_at };
  }

  return { cached: false };
}

/**
 * List metadata for every persisted thread (from DB).
 * Useful for a "saved threads" panel in the popup.
 *
 * @returns {Promise<Array>}
 */
export async function cacheListAll() {
  return dbListAll();
}