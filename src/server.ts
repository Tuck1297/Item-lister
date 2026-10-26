import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from './config';
import {
  addPhotos,
  createItem,
  deleteItem,
  deletePhoto,
  getItem,
  listItems,
  makeCoverPhoto,
  saveListing,
  setItemStatus,
  updateItem,
} from './db';
import { enqueue } from './jobs';
import { publishers } from './platforms';
import { shortError } from './platforms/browser';
import { isConnected, missingAppConfig, missingListingConfig } from './platforms/ebay/client';
import { FACEBOOK_CATEGORIES } from './platforms/facebook';
import { HttpError, PLATFORMS } from './types';
import { parseItemInput, parsePlatforms } from './validate';

const MAX_BODY_BYTES = 250 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

// ---------- Tiny router ----------

type Params = Record<string, string>;
type Handler = (req: IncomingMessage, res: ServerResponse, params: Params) => Promise<unknown> | unknown;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];

function route(method: string, pathPattern: string, handler: Handler): void {
  const keys: string[] = [];
  const source = pathPattern.replace(/:(\w+)/g, (_, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  routes.push({ method, pattern: new RegExp(`^${source}$`), keys, handler });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function idParam(params: Params, key = 'id'): number {
  const id = Number(params[key]);
  if (!Number.isInteger(id)) throw new HttpError(400, `Invalid ${key}`);
  return id;
}

function requireItem(id: number) {
  const item = getItem(id);
  if (!item) throw new HttpError(404, 'Item not found');
  return item;
}

// ---------- Body parsing ----------

function webRequest(req: IncomingMessage): Request {
  const length = Number(req.headers['content-length'] ?? 0);
  if (length > MAX_BODY_BYTES) throw new HttpError(413, 'Upload too large');
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
  }
  return new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers,
    body: Readable.toWeb(req) as ReadableStream,
    duplex: 'half',
  } as RequestInit);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return (await webRequest(req).json()) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Expected a JSON body');
  }
}

/** Parses a multipart item form: text fields plus any number of "photos" files. */
async function readItemForm(req: IncomingMessage): Promise<{ fields: Record<string, string>; photos: File[] }> {
  let form: FormData;
  try {
    form = await webRequest(req).formData();
  } catch {
    throw new HttpError(400, 'Expected a multipart form');
  }
  const fields: Record<string, string> = {};
  const photos: File[] = [];
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') fields[key] = value;
    else if (key === 'photos' && value.size > 0) photos.push(value);
  }
  for (const photo of photos) {
    if (!IMAGE_TYPES[photo.type]) {
      throw new HttpError(400, `${photo.name}: use JPEG, PNG or WebP photos (iPhone HEIC files aren't accepted everywhere)`);
    }
  }
  return { fields, photos };
}

async function savePhotos(photos: File[]): Promise<string[]> {
  const names: string[] = [];
  for (const photo of photos) {
    const name = `${randomUUID()}${IMAGE_TYPES[photo.type]}`;
    await fs.promises.writeFile(path.join(config.uploadsDir, name), Buffer.from(await photo.arrayBuffer()));
    names.push(name);
  }
  return names;
}

function friendlyDbError(err: unknown): never {
  if (err instanceof Error && err.message.includes('UNIQUE constraint failed: items.sku')) {
    throw new HttpError(409, 'Another item already uses that SKU');
  }
  throw err;
}

// ---------- API ----------

route('GET', '/api/config', () => ({
  postMode: config.postMode,
  platforms: PLATFORMS.map((p) => ({ id: p, label: publishers[p].label })),
  facebookCategories: FACEBOOK_CATEGORIES,
  ebay: {
    env: config.ebay.env,
    missing: [...missingAppConfig(), ...missingListingConfig()],
    connected: isConnected(),
  },
}));

route('GET', '/api/items', () => listItems());

route('GET', '/api/items/:id', (_req, _res, params) => requireItem(idParam(params)));

route('POST', '/api/items', async (req, res) => {
  const { fields, photos } = await readItemForm(req);
  const input = parseItemInput(fields);
  let id: number;
  try {
    id = createItem(input);
  } catch (err) {
    friendlyDbError(err);
  }
  addPhotos(id, await savePhotos(photos));
  json(res, 201, getItem(id));
});

route('PUT', '/api/items/:id', async (req, _res, params) => {
  const item = requireItem(idParam(params));
  const { fields, photos } = await readItemForm(req);
  const input = parseItemInput(fields, item.sku);
  try {
    updateItem(item.id, input);
  } catch (err) {
    friendlyDbError(err);
  }
  addPhotos(item.id, await savePhotos(photos));
  return getItem(item.id);
});

route('DELETE', '/api/items/:id', (_req, _res, params) => {
  const item = requireItem(idParam(params));
  deleteItem(item.id);
  return { ok: true };
});

route('DELETE', '/api/items/:id/photos/:photoId', (_req, _res, params) => {
  const itemId = idParam(params);
  if (!deletePhoto(itemId, idParam(params, 'photoId'))) throw new HttpError(404, 'Photo not found');
  return getItem(itemId);
});

route('POST', '/api/items/:id/photos/:photoId/cover', (_req, _res, params) => {
  const itemId = idParam(params);
  makeCoverPhoto(itemId, idParam(params, 'photoId'));
  return requireItem(itemId);
});

route('POST', '/api/items/:id/post', async (req, _res, params) => {
  const item = requireItem(idParam(params));
  if (item.status === 'sold') throw new HttpError(400, 'This item is marked sold');
  if (!item.photos.length) throw new HttpError(400, 'Add at least one photo before posting');
  const { platforms } = await readJson(req);
  for (const platform of parsePlatforms(platforms)) enqueue(item.id, platform);
  return getItem(item.id);
});

/** Marks the item sold, ends the eBay listing, and flags the browser platforms to delist by hand. */
route('POST', '/api/items/:id/sold', async (_req, _res, params) => {
  const item = requireItem(idParam(params));
  setItemStatus(item.id, 'sold');
  for (const listing of item.listings) {
    if (listing.status !== 'listed' && listing.status !== 'awaiting_review') continue;
    const publisher = publishers[listing.platform];
    if (publisher.delist && listing.status === 'listed') {
      try {
        await publisher.delist(item, listing);
        saveListing(item.id, listing.platform, { status: 'delisted', message: 'Ended because the item sold' });
      } catch (err) {
        saveListing(item.id, listing.platform, { status: 'delist_manually', message: shortError(err) });
      }
    } else {
      saveListing(item.id, listing.platform, {
        status: 'delist_manually',
        message: `Mark it sold or delete it on ${publisher.label}`,
      });
    }
  }
  return getItem(item.id);
});

route('POST', '/api/items/:id/relist', (_req, _res, params) => {
  const item = requireItem(idParam(params));
  setItemStatus(item.id, 'active');
  return getItem(item.id);
});

/** After you've ended a Facebook/Poshmark listing yourself. */
route('POST', '/api/items/:id/listings/:platform/delisted', (_req, _res, params) => {
  const item = requireItem(idParam(params));
  const [platform] = parsePlatforms(params.platform);
  saveListing(item.id, platform!, { status: 'delisted', message: null });
  return getItem(item.id);
});

// ---------- Static files ----------

function serveFile(res: ServerResponse, baseDir: string, relative: string): boolean {
  const file = path.resolve(baseDir, `.${path.sep}${decodeURIComponent(relative)}`);
  if (!file.startsWith(baseDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    for (const r of routes) {
      const match = r.method === req.method ? r.pattern.exec(url.pathname) : null;
      if (!match) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1]!)]));
      const result = await r.handler(req, res, params);
      if (!res.headersSent) json(res, 200, result ?? { ok: true });
      return;
    }
    if (req.method === 'GET') {
      if (url.pathname.startsWith('/uploads/') && serveFile(res, config.uploadsDir, url.pathname.slice(9))) return;
      const page = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (serveFile(res, config.publicDir, page)) return;
    }
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) json(res, status, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Crosslister running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`Posting mode: ${config.postMode === 'auto' ? 'auto-publish' : 'review before publish'} · eBay: ${config.ebay.env}`);
});
