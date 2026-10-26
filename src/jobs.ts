import { getItem, getListing, saveListing } from './db';
import { publishers } from './platforms';
import { setConnected } from './connections';
import { NotLoggedInError, shortError } from './platforms/browser';
import { BUSY_STATUSES, type Platform } from './types';

/**
 * One queue per platform: eBay (API) runs alongside the browser platforms, but each
 * browser site only ever has one listing form open at a time.
 */
const queues = new Map<Platform, Promise<void>>();

export function enqueue(itemId: number, platform: Platform): boolean {
  const current = getListing(itemId, platform);
  if (current && BUSY_STATUSES.includes(current.status)) return false;

  saveListing(itemId, platform, { status: 'queued', message: null });
  const next = (queues.get(platform) ?? Promise.resolve()).then(() => run(itemId, platform));
  queues.set(platform, next);
  return true;
}

async function run(itemId: number, platform: Platform): Promise<void> {
  const item = getItem(itemId);
  if (!item) return; // deleted while queued

  const previous = getListing(itemId, platform);
  saveListing(itemId, platform, { status: 'posting', message: null });
  console.log(`[${platform}] posting item ${itemId} (${item.sku})`);

  try {
    const result = await publishers[platform].publish(item, {
      previous,
      report: (patch) => saveListing(itemId, platform, patch),
    });
    saveListing(itemId, platform, { status: 'listed', ...result });
    if (platform !== 'ebay') setConnected(platform, true);
    console.log(`[${platform}] listed item ${itemId}${result.url ? ` → ${result.url}` : ''}`);
  } catch (err) {
    const message = shortError(err);
    if (err instanceof NotLoggedInError && platform !== 'ebay') setConnected(platform, false);
    console.error(`[${platform}] item ${itemId} failed: ${message}`);
    if (getItem(itemId)) saveListing(itemId, platform, { status: 'failed', message });
  }
}
