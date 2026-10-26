import { randomBytes } from 'node:crypto';
import { CONDITIONS, HttpError, PLATFORMS, type Condition, type ItemInput, type Platform } from './types';

type Fields = Record<string, unknown>;

function text(fields: Fields, key: string): string {
  const value = fields[key];
  return value == null ? '' : String(value).trim();
}

function money(fields: Fields, key: string, label: string, required: boolean): number | null {
  const raw = text(fields, key).replace(/[$,\s]/g, '');
  if (!raw) {
    if (required) throw new HttpError(400, `${label} is required`);
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new HttpError(400, `${label} must be a positive number`);
  return Math.round(value * 100);
}

export function newSku(): string {
  return `CL-${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString('hex').toUpperCase()}`;
}

export function parseItemInput(fields: Fields, existingSku?: string): ItemInput {
  const title = text(fields, 'title');
  if (!title) throw new HttpError(400, 'Title is required');
  if (title.length > 80) throw new HttpError(400, 'Title must be 80 characters or fewer (eBay and Poshmark limit)');

  const sku = text(fields, 'sku') || existingSku || newSku();
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(sku)) {
    throw new HttpError(400, 'SKU can only use letters, numbers, - and _ (max 50)');
  }

  const quantity = text(fields, 'quantity') ? Number(text(fields, 'quantity')) : 1;
  if (!Number.isInteger(quantity) || quantity < 1) throw new HttpError(400, 'Quantity must be a whole number ≥ 1');

  const condition = (text(fields, 'condition') || 'good') as Condition;
  if (!CONDITIONS.includes(condition)) {
    throw new HttpError(400, `Condition must be one of: ${CONDITIONS.join(', ')}`);
  }

  const weightRaw = text(fields, 'weight_oz');
  const weight = weightRaw ? Number(weightRaw) : null;
  if (weight !== null && (!Number.isFinite(weight) || weight <= 0)) {
    throw new HttpError(400, 'Weight must be a positive number of ounces');
  }

  const ebayCategory = text(fields, 'ebay_category_id');
  if (ebayCategory && !/^\d+$/.test(ebayCategory)) throw new HttpError(400, 'eBay category ID must be numeric');

  return {
    sku,
    title,
    description: text(fields, 'description'),
    price_cents: money(fields, 'price', 'Price', true)!,
    original_price_cents: money(fields, 'original_price', 'Original price', false),
    quantity,
    condition,
    brand: text(fields, 'brand'),
    size: text(fields, 'size'),
    color: text(fields, 'color'),
    weight_oz: weight,
    ebay_category_id: ebayCategory,
    ebay_aspects: text(fields, 'ebay_aspects'),
    facebook_category: text(fields, 'facebook_category'),
    poshmark_category: text(fields, 'poshmark_category'),
  };
}

export function parsePlatforms(value: unknown): Platform[] {
  const list = Array.isArray(value) ? value : [value];
  const platforms = list.filter((p): p is Platform => PLATFORMS.includes(p as Platform));
  if (!platforms.length) throw new HttpError(400, `Pick at least one platform: ${PLATFORMS.join(', ')}`);
  return [...new Set(platforms)];
}
