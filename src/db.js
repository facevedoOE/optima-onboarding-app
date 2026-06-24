// ---------------------------------------------------------------------------
// Data layer.
//
// ONE place the app talks to storage, behind a small synchronous interface.
//   • No DATABASE_URL  → JSON file store (data/store.json). Zero-setup demo.
//   • DATABASE_URL set → PostgreSQL. Rows live in a `store` table (one JSONB doc
//     per record); the whole store is loaded into an in-memory cache at startup
//     (db.init), reads are served from cache, and every mutation is written
//     through to Postgres via a serialized queue. This keeps the existing
//     synchronous call sites (db.find/filter/get/insert/update/remove) unchanged
//     while making the data durable (survives restarts/redeploys) with real
//     backups via the managed database.
//
// Single-instance: the in-memory cache is per-process, so run ONE App Service
// instance (don't scale out) until/unless reads go straight to Postgres.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DATA_FILE = join(DATA_DIR, 'store.json');

const COLLECTIONS = ['candidates', 'formDefinitions', 'submissions', 'accessRoles', 'accessRequests', 'references'];
const EMPTY = () => Object.fromEntries(COLLECTIONS.map((c) => [c, []]));

const DATABASE_URL = process.env.DATABASE_URL || '';
const USE_PG = !!DATABASE_URL;

let cache = null;
let pool = null;

// Stable storage key for a row (all collections carry `id`; form defs use id===key).
const pkOf = (row) => row.id || row.key;

// ── Postgres write-through queue ────────────────────────────────────────────
// Mutations return synchronously from the cache; the matching SQL is appended to
// a single promise chain so writes land in order. db.flush() awaits the chain —
// short-lived processes (seed scripts) MUST call it before exiting.
let writeChain = Promise.resolve();
function enqueue(fn) {
  writeChain = writeChain.then(fn).catch((e) => console.error('[db] postgres write failed:', e.message));
}

function nowISO() { return new Date().toISOString(); }

// ── File mode ────────────────────────────────────────────────────────────────
function fileLoad() {
  if (cache) return cache;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(DATA_FILE)) {
    try {
      cache = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
      for (const k of COLLECTIONS) if (!cache[k]) cache[k] = [];
    } catch (e) {
      try { renameSync(DATA_FILE, DATA_FILE + '.corrupt-' + Date.now()); } catch (_) {}
      console.error('store.json was unreadable; backed it up and started empty:', e.message);
      cache = EMPTY();
    }
  } else cache = EMPTY();
  return cache;
}
function filePersist() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, DATA_FILE);
}

function ensureLoaded() {
  if (cache) return cache;
  if (USE_PG) throw new Error('[db] used before init() — call `await db.init()` at startup');
  return fileLoad();
}

// Persist a single-collection change (PG: write-through; file: rewrite store).
function persistInsertOrUpdate(collection, row) {
  if (!USE_PG) return filePersist();
  enqueue(() => pool.query(
    'INSERT INTO store (collection, id, doc) VALUES ($1,$2,$3) ON CONFLICT (collection, id) DO UPDATE SET doc = EXCLUDED.doc',
    [collection, pkOf(row), row],
  ));
}

// Generic collection helpers -------------------------------------------------
export const db = {
  // Load the store into memory. No-op-ish in file mode; required in PG mode.
  async init() {
    if (!USE_PG) { fileLoad(); console.log('[db] JSON file store (no DATABASE_URL set).'); return; }
    const pgmod = await import('pg');
    const { Pool } = pgmod.default || pgmod;
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS store (
      seq        bigserial PRIMARY KEY,
      collection text NOT NULL,
      id         text NOT NULL,
      doc        jsonb NOT NULL,
      UNIQUE (collection, id)
    )`);
    const { rows } = await pool.query('SELECT collection, doc FROM store ORDER BY seq');
    cache = EMPTY();
    for (const r of rows) (cache[r.collection] = cache[r.collection] || []).push(r.doc);
    for (const k of COLLECTIONS) if (!cache[k]) cache[k] = [];
    console.log(`[db] PostgreSQL store ready (${rows.length} rows loaded).`);
  },
  // Await all pending Postgres writes. Call before a short-lived process exits.
  async flush() { await writeChain; },

  all(collection) { return ensureLoaded()[collection]; },
  find(collection, predicate) { return ensureLoaded()[collection].find(predicate); },
  filter(collection, predicate) { return ensureLoaded()[collection].filter(predicate); },
  get(collection, id) { return ensureLoaded()[collection].find((r) => r.id === id); },

  insert(collection, record) {
    const c = ensureLoaded();
    const row = { id: record.id || randomUUID(), createdAt: nowISO(), ...record };
    c[collection].push(row);
    persistInsertOrUpdate(collection, row);
    return row;
  },
  update(collection, id, patch) {
    const c = ensureLoaded();
    const row = c[collection].find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: nowISO() });
    persistInsertOrUpdate(collection, row);
    return row;
  },
  remove(collection, id) {
    const c = ensureLoaded();
    const i = c[collection].findIndex((r) => r.id === id);
    if (i === -1) return false;
    const [removed] = c[collection].splice(i, 1);
    if (USE_PG) enqueue(() => pool.query('DELETE FROM store WHERE collection=$1 AND id=$2', [collection, pkOf(removed)]));
    else filePersist();
    return true;
  },
  // Replace an entire collection (used by the seeder).
  replace(collection, rows) {
    const c = ensureLoaded();
    c[collection] = rows;
    if (USE_PG) enqueue(async () => {
      await pool.query('DELETE FROM store WHERE collection=$1', [collection]);
      for (const row of rows) {
        await pool.query('INSERT INTO store (collection, id, doc) VALUES ($1,$2,$3) ON CONFLICT (collection, id) DO UPDATE SET doc = EXCLUDED.doc', [collection, pkOf(row), row]);
      }
    });
    else filePersist();
  },
  reset() {
    cache = EMPTY();
    if (USE_PG) enqueue(() => pool.query('TRUNCATE store'));
    else filePersist();
  },
};

export { nowISO };
