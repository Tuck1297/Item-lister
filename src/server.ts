import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from './config';
import { checkLogin, connectionStatus, isSite, logout, startLogin } from './connections';
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
import {
  consentUrl,
  disconnect as disconnectEbay,
  exchangeCode,
  isConnected,
  missingAppConfig,
  missingListingConfig,
  saveListingSettings,
} from './platforms/ebay/client';
import { createDefaultPolicies, createLocation, getSetupStatus } from './platforms/ebay/setup';
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
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
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
}));

// ---------- Connections (logins) ----------

function ebayStatus() {
  const missingKeys = missingAppConfig();
  const connected = missingKeys.length === 0 && isConnected();
  return {
    env: config.ebay.env,
    missingKeys,
    connected,
    missingSetup: connected ? missingListingConfig() : [],
    consentUrl: missingKeys.length ? null : consentUrl(),
    callbackUrl: `http://localhost:${config.port}/api/ebay/callback`,
  };
}

route('GET', '/api/connections', () => ({ sites: connectionStatus(), ebay: ebayStatus() }));

function siteParam(params: Params) {
  const site = params.site ?? '';
  if (!isSite(site)) throw new HttpError(404, 'Unknown site');
  return site;
}

/** Opens a browser window on the site's login page; the server closes it once you're logged in. */
route('POST', '/api/connections/:site/login', async (_req, _res, params) => {
  await startLogin(siteParam(params));
  return { sites: connectionStatus(), ebay: ebayStatus() };
});

route('POST', '/api/connections/:site/check', async (_req, _res, params) => {
  await checkLogin(siteParam(params));
  return { sites: connectionStatus(), ebay: ebayStatus() };
});

route('POST', '/api/connections/:site/logout', async (_req, _res, params) => {
  await logout(siteParam(params));
  return { sites: connectionStatus(), ebay: ebayStatus() };
});

function codeFromRedirect(value: string): string {
  const raw = value.match(/[?&]code=([^&#]+)/)?.[1] ?? value.trim();
  if (!raw) throw new HttpError(400, 'Paste the full URL eBay sent you to after you clicked Agree');
  return decodeURIComponent(raw);
}

/** Paste-back flow: works with any "auth accepted" URL you configured on the eBay developer portal. */
route('POST', '/api/ebay/connect', async (req) => {
  const missing = missingAppConfig();
  if (missing.length) throw new HttpError(400, `Add ${missing.join(', ')} to .env and restart the server first`);
  const { redirectUrl } = await readJson(req);
  await exchangeCode(codeFromRedirect(String(redirectUrl ?? '')));
  return { sites: connectionStatus(), ebay: ebayStatus() };
});

/** Automatic flow: used when your eBay "auth accepted" URL points at this server. */
route('GET', '/api/ebay/callback', async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let target = '/?ebay=connected';
  try {
    const code = url.searchParams.get('code');
    if (!code) throw new Error(url.searchParams.get('error_description') ?? 'eBay did not send an authorization code');
    await exchangeCode(code);
  } catch (err) {
    target = `/?ebay_error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`;
  }
  res.writeHead(302, { Location: target });
  res.end();
});

route('POST', '/api/ebay/disconnect', () => {
  disconnectEbay();
  return { sites: connectionStatus(), ebay: ebayStatus() };
});

route('GET', '/api/ebay/setup', () => getSetupStatus());

route('PUT', '/api/ebay/setup', async (req) => {
  const body = await readJson(req);
  const pick = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : undefined);
  saveListingSettings({
    fulfillmentPolicyId: pick('fulfillmentPolicyId'),
    paymentPolicyId: pick('paymentPolicyId'),
    returnPolicyId: pick('returnPolicyId'),
  });
  return getSetupStatus();
});

route('POST', '/api/ebay/location', async (req) => {
  const { postalCode } = await readJson(req);
  const zip = String(postalCode ?? '').trim();
  if (!zip) throw new HttpError(400, 'Enter the postal code you ship from');
  await createLocation(zip);
  return getSetupStatus();
});

route('POST', '/api/ebay/default-policies', async () => {
  await createDefaultPolicies();
  return getSetupStatus();
});

// ---------- Items ----------

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
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (url.pathname.startsWith('/uploads/')) {
        if (serveFile(res, config.uploadsDir, url.pathname.slice(9))) return;
      } else if (serveFile(res, config.webDir, url.pathname.slice(1)) || serveFile(res, config.webDir, 'index.html')) {
        return; // built UI, with index.html as the fallback for client-side routes
      } else {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('The UI has not been built yet. Run `npm run build` (or `npm run dev` while developing).');
        return;
      }
    }
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) json(res, status, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Item Lister API running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`Posting mode: ${config.postMode === 'auto' ? 'auto-publish' : 'review before publish'} · eBay: ${config.ebay.env}`);
});
