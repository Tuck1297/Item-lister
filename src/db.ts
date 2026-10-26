import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config';
import type { Item, ItemFull, ItemInput, Listing, ListingPatch, Photo, Platform } from './types';

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS items (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    sku                  TEXT    NOT NULL UNIQUE,
    title                TEXT    NOT NULL,
    description          TEXT    NOT NULL DEFAULT '',
    price_cents          INTEGER NOT NULL,
    original_price_cents INTEGER,
    quantity             INTEGER NOT NULL DEFAULT 1,
    condition            TEXT    NOT NULL DEFAULT 'good',
    brand                TEXT    NOT NULL DEFAULT '',
    size                 TEXT    NOT NULL DEFAULT '',
    color                TEXT    NOT NULL DEFAULT '',
    weight_oz            REAL,
    ebay_category_id     TEXT    NOT NULL DEFAULT '',
    ebay_aspects         TEXT    NOT NULL DEFAULT '',
    facebook_category    TEXT    NOT NULL DEFAULT '',
    poshmark_category    TEXT    NOT NULL DEFAULT '',
    status               TEXT    NOT NULL DEFAULT 'active',
    created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS photos (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    filename TEXT    NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS listings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    platform    TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    external_id TEXT,
    url         TEXT,
    message     TEXT,
    meta        TEXT    NOT NULL DEFAULT '{}',
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (item_id, platform)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? String(row.value) : undefined;
}

export function setSetting(key: string, value: string | null): void {
  if (value === null || value === '') db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

// Jobs run in memory, so anything mid-flight when the server stopped is gone.
db.exec(`
  UPDATE listings
     SET status = 'failed', message = 'Interrupted: the server stopped while this was running'
   WHERE status IN ('queued', 'posting', 'awaiting_review')
`);

const ITEM_FIELDS = [
  'sku',
  'title',
  'description',
  'price_cents',
  'original_price_cents',
  'quantity',
  'condition',
  'brand',
  'size',
  'color',
  'weight_oz',
  'ebay_category_id',
  'ebay_aspects',
  'facebook_category',
  'poshmark_category',
] as const satisfies readonly (keyof ItemInput)[];

function itemParams(input: ItemInput): Record<string, string | number | null> {
  return Object.fromEntries(ITEM_FIELDS.map((f) => [f, input[f]]));
}

type Row = Record<string, unknown>;

function toListing(row: Row): Listing {
  return { ...(row as unknown as Listing), meta: JSON.parse(String(row.meta ?? '{}')) };
}

export function createItem(input: ItemInput): number {
  const cols = ITEM_FIELDS.join(', ');
  const vals = ITEM_FIELDS.map((f) => `$${f}`).join(', ');
  const result = db.prepare(`INSERT INTO items (${cols}) VALUES (${vals})`).run(itemParams(input));
  return Number(result.lastInsertRowid);
}

export function updateItem(id: number, input: ItemInput): void {
  const sets = ITEM_FIELDS.map((f) => `${f} = $${f}`).join(', ');
  db.prepare(`UPDATE items SET ${sets}, updated_at = datetime('now') WHERE id = $id`).run({
    ...itemParams(input),
    id,
  });
}

export function setItemStatus(id: number, status: Item['status']): void {
  db.prepare(`UPDATE items SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
}

export function deleteItem(id: number): void {
  for (const photo of photosFor(id)) removePhotoFile(photo.filename);
  db.prepare('DELETE FROM items WHERE id = ?').run(id);
}

function photosFor(itemId: number): Photo[] {
  return db
    .prepare('SELECT * FROM photos WHERE item_id = ? ORDER BY position, id')
    .all(itemId) as unknown as Photo[];
}

export function addPhotos(itemId: number, filenames: string[]): void {
  const row = db.prepare('SELECT COALESCE(MAX(position), -1) AS max FROM photos WHERE item_id = ?').get(itemId);
  let position = Number(row?.max ?? -1) + 1;
  const insert = db.prepare('INSERT INTO photos (item_id, filename, position) VALUES (?, ?, ?)');
  for (const filename of filenames) insert.run(itemId, filename, position++);
}

export function deletePhoto(itemId: number, photoId: number): boolean {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND item_id = ?').get(photoId, itemId) as
    | Photo
    | undefined;
  if (!photo) return false;
  db.prepare('DELETE FROM photos WHERE id = ?').run(photoId);
  removePhotoFile(photo.filename);
  return true;
}

/** Moves a photo to the front so every platform uses it as the cover image. */
export function makeCoverPhoto(itemId: number, photoId: number): void {
  const ordered = photosFor(itemId).map((p) => p.id);
  if (!ordered.includes(photoId)) return;
  const next = [photoId, ...ordered.filter((id) => id !== photoId)];
  const update = db.prepare('UPDATE photos SET position = ? WHERE id = ?');
  next.forEach((id, i) => update.run(i, id));
}

export function photoPath(photo: Photo): string {
  return path.join(config.uploadsDir, photo.filename);
}

function removePhotoFile(filename: string): void {
  fs.rm(path.join(config.uploadsDir, filename), { force: true }, () => {});
}

export function getItem(id: number): ItemFull | undefined {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Item | undefined;
  if (!item) return undefined;
  const listings = db.prepare('SELECT * FROM listings WHERE item_id = ?').all(id).map(toListing);
  return { ...item, photos: photosFor(id), listings };
}

export function listItems(): ItemFull[] {
  const items = db.prepare('SELECT * FROM items ORDER BY status = \'sold\', id DESC').all() as unknown as Item[];
  const photos = db.prepare('SELECT * FROM photos ORDER BY position, id').all() as unknown as Photo[];
  const listings = db.prepare('SELECT * FROM listings').all().map(toListing);
  return items.map((item) => ({
    ...item,
    photos: photos.filter((p) => p.item_id === item.id),
    listings: listings.filter((l) => l.item_id === item.id),
  }));
}

export function getListing(itemId: number, platform: Platform): Listing | undefined {
  const row = db.prepare('SELECT * FROM listings WHERE item_id = ? AND platform = ?').get(itemId, platform);
  return row ? toListing(row) : undefined;
}

export function saveListing(itemId: number, platform: Platform, patch: ListingPatch): Listing {
  const prev = getListing(itemId, platform);
  const pick = <K extends 'external_id' | 'url' | 'message'>(key: K) =>
    patch[key] !== undefined ? patch[key] : (prev?.[key] ?? null);

  db.prepare(
    `INSERT INTO listings (item_id, platform, status, external_id, url, message, meta, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (item_id, platform) DO UPDATE SET
       status = excluded.status, external_id = excluded.external_id, url = excluded.url,
       message = excluded.message, meta = excluded.meta, updated_at = excluded.updated_at`,
  ).run(
    itemId,
    platform,
    patch.status ?? prev?.status ?? 'queued',
    pick('external_id'),
    pick('url'),
    pick('message'),
    JSON.stringify({ ...prev?.meta, ...patch.meta }),
  );
  return getListing(itemId, platform)!;
}
