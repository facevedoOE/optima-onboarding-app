// ---------------------------------------------------------------------------
// Data layer.
//
// This is the ONE place the app talks to storage. Today it's a JSON file so the
// prototype runs anywhere with zero setup. To move to production, reimplement
// these same functions against Dataverse / SQL / SharePoint — nothing else in
// the app changes. That is the whole point of keeping it behind this interface.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DATA_FILE = join(DATA_DIR, 'store.json');

const EMPTY = {
  candidates: [],
  formDefinitions: [],
  submissions: [],
  accessRoles: [],
  accessRequests: [],
  references: [],
};

let cache = null;

function load() {
  if (cache) return cache;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(DATA_FILE)) {
    try {
      cache = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
      for (const k of Object.keys(EMPTY)) if (!cache[k]) cache[k] = [];
    } catch (e) {
      // Corrupt store: back it up rather than crash, and start clean.
      try { renameSync(DATA_FILE, DATA_FILE + '.corrupt-' + Date.now()); } catch (_) {}
      console.error('store.json was unreadable; backed it up and started empty:', e.message);
      cache = structuredClone(EMPTY);
    }
  } else {
    cache = structuredClone(EMPTY);
  }
  return cache;
}

function persist() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  // Atomic write: write a temp file then rename, so a crash mid-write can't corrupt the store.
  const tmp = DATA_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, DATA_FILE);
}

function nowISO() {
  return new Date().toISOString();
}

// Generic collection helpers -------------------------------------------------
export const db = {
  all(collection) {
    return load()[collection];
  },
  find(collection, predicate) {
    return load()[collection].find(predicate);
  },
  filter(collection, predicate) {
    return load()[collection].filter(predicate);
  },
  get(collection, id) {
    return load()[collection].find((r) => r.id === id);
  },
  insert(collection, record) {
    const c = load();
    const row = { id: record.id || randomUUID(), createdAt: nowISO(), ...record };
    c[collection].push(row);
    persist();
    return row;
  },
  update(collection, id, patch) {
    const c = load();
    const row = c[collection].find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: nowISO() });
    persist();
    return row;
  },
  remove(collection, id) {
    const c = load();
    const i = c[collection].findIndex((r) => r.id === id);
    if (i === -1) return false;
    c[collection].splice(i, 1);
    persist();
    return true;
  },
  // Replace an entire collection (used by the seeder).
  replace(collection, rows) {
    const c = load();
    c[collection] = rows;
    persist();
  },
  reset() {
    cache = structuredClone(EMPTY);
    persist();
  },
};

export { nowISO };
