import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config';
import { photoPath } from '../../db';
import type { Condition, ItemFull } from '../../types';
import type { Publisher } from '../types';
import {
  EbayApiError,
  ebayHosts,
  ebayRequest,
  isConnected,
  listingSettings,
  missingAppConfig,
  missingListingConfig,
} from './client';

const INVENTORY = '/sell/inventory/v1';
const TAXONOMY = '/commerce/taxonomy/v1';
const MAX_PHOTOS = 24;

/**
 * "USED_EXCELLENT" is eBay's condition 3000 ("Used" / "Pre-owned - Good"), which nearly
 * every category accepts. The finer grade goes in the condition description.
 */
const CONDITION_TEXT: Record<Exclude<Condition, 'new'>, string> = {
  like_new: 'Like new: used briefly, no visible wear.',
  good: 'Good: light signs of use.',
  fair: 'Fair: noticeable wear, fully functional.',
  poor: 'Poor: heavy wear. See photos.',
};

// ---------- Images (eBay hosts them for us via the Media API) ----------

async function uploadImage(file: string): Promise<string> {
  const ext = path.extname(file).slice(1).toLowerCase();
  const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const form = new FormData();
  form.append('image', await fs.openAsBlob(file, { type }), path.basename(file));

  const created = await ebayRequest<{ imageUrl?: string }>(
    'POST',
    `${ebayHosts().media}/commerce/media/v1_beta/image/create_image_from_file`,
    { form },
  );
  if (created.data?.imageUrl) return created.data.imageUrl;

  const location = created.headers.get('location');
  if (!location) throw new Error('eBay image upload returned no image location');
  const image = await ebayRequest<{ imageUrl: string }>('GET', location);
  return image.data.imageUrl;
}

// ---------- Category + item specifics ----------

let treeId: string | undefined;

async function categoryTreeId(): Promise<string> {
  treeId ??= (
    await ebayRequest<{ categoryTreeId: string }>(
      'GET',
      `${TAXONOMY}/get_default_category_tree_id?marketplace_id=${config.ebay.marketplaceId}`,
      { auth: 'app' },
    )
  ).data.categoryTreeId;
  return treeId;
}

async function suggestCategory(title: string): Promise<{ id: string; name: string }> {
  const res = await ebayRequest<{ categorySuggestions?: { category: { categoryId: string; categoryName: string } }[] }>(
    'GET',
    `${TAXONOMY}/category_tree/${await categoryTreeId()}/get_category_suggestions?q=${encodeURIComponent(title)}`,
    { auth: 'app' },
  );
  const top = res.data.categorySuggestions?.[0]?.category;
  if (!top) throw new Error('eBay could not suggest a category for this title. Set an eBay category ID on the item');
  return { id: top.categoryId, name: top.categoryName };
}

async function requiredAspects(categoryId: string): Promise<string[]> {
  try {
    const res = await ebayRequest<{
      aspects?: { localizedAspectName: string; aspectConstraint?: { aspectRequired?: boolean } }[];
    }>(
      'GET',
      `${TAXONOMY}/category_tree/${await categoryTreeId()}/get_item_aspects_for_category?category_id=${categoryId}`,
      { auth: 'app' },
    );
    return (res.data.aspects ?? []).filter((a) => a.aspectConstraint?.aspectRequired).map((a) => a.localizedAspectName);
  } catch (err) {
    if (err instanceof EbayApiError && err.status === 404) return [];
    throw err;
  }
}

/** "Name: value" per line; "Name: a | b" for multiple values. */
export function parseAspects(textValue: string): Record<string, string[]> {
  const aspects: Record<string, string[]> = {};
  for (const line of textValue.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    const name = line.slice(0, idx).trim();
    const values = line
      .slice(idx + 1)
      .split('|')
      .map((v) => v.trim())
      .filter(Boolean);
    if (name && values.length) aspects[name] = values;
  }
  return aspects;
}

async function buildAspects(item: ItemFull, categoryId: string): Promise<Record<string, string[]>> {
  const aspects = parseAspects(item.ebay_aspects);
  const has = (name: string) => Object.keys(aspects).some((k) => k.toLowerCase() === name.toLowerCase());
  if (item.brand && !has('Brand')) aspects.Brand = [item.brand];
  if (item.color && !has('Color')) aspects.Color = [item.color];
  if (item.size && !has('Size')) aspects.Size = [item.size];

  const required = await requiredAspects(categoryId);
  if (required.some((r) => r.toLowerCase() === 'brand') && !has('Brand')) aspects.Brand = ['Unbranded'];

  const missing = required.filter((r) => !has(r));
  if (missing.length) {
    throw new Error(
      `eBay category ${categoryId} requires these item specifics: ${missing.join(', ')}. ` +
        'Add them to "eBay item specifics" as "Name: value" lines',
    );
  }
  return aspects;
}

// ---------- Listing ----------

function htmlDescription(textValue: string): string {
  const escaped = textValue.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

interface Offer {
  offerId: string;
  status: 'PUBLISHED' | 'UNPUBLISHED';
  listing?: { listingId?: string };
}

async function findOffer(sku: string): Promise<Offer | undefined> {
  try {
    const res = await ebayRequest<{ offers?: Offer[] }>(
      'GET',
      `${INVENTORY}/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${config.ebay.marketplaceId}`,
    );
    return res.data.offers?.[0];
  } catch (err) {
    if (err instanceof EbayApiError && (err.status === 404 || err.errors.some((e) => e.errorId === 25713))) {
      return undefined;
    }
    throw err;
  }
}

export const ebay: Publisher = {
  platform: 'ebay',
  label: 'eBay',

  async publish(item, ctx) {
    const missingKeys = missingAppConfig();
    if (missingKeys.length) throw new Error(`eBay isn't set up yet. Add ${missingKeys.join(', ')} to .env (see README)`);
    if (!isConnected()) throw new Error("eBay isn't connected yet. Connect it from Connections");
    const missingSetup = missingListingConfig();
    if (missingSetup.length) throw new Error(`Choose your eBay ${missingSetup.join(', ')} in Connections`);
    const settings = listingSettings();
    if (!item.photos.length) throw new Error('eBay needs at least one photo');

    const notes: string[] = [];

    // 1. Photos, cached per photo so retries don't re-upload.
    const cached = (ctx.previous?.meta.imageUrls ?? {}) as Record<string, string>;
    const imageUrls: Record<string, string> = {};
    for (const photo of item.photos.slice(0, MAX_PHOTOS)) {
      imageUrls[photo.id] = cached[photo.id] ?? (await uploadImage(photoPath(photo)));
    }
    ctx.report({ meta: { imageUrls } });

    // 2. Category + required item specifics.
    const previousCategory = ctx.previous?.meta.categoryId;
    let categoryId = item.ebay_category_id || (typeof previousCategory === 'string' ? previousCategory : '');
    if (!categoryId) {
      const suggestion = await suggestCategory(item.title);
      categoryId = suggestion.id;
      notes.push(`Category auto-picked: ${suggestion.name} (${suggestion.id})`);
    }
    const aspects = await buildAspects(item, categoryId);

    // 3. Inventory item (keyed by SKU, so re-posting updates it in place).
    await ebayRequest('PUT', `${INVENTORY}/inventory_item/${encodeURIComponent(item.sku)}`, {
      body: {
        availability: { shipToLocationAvailability: { quantity: item.quantity } },
        condition: item.condition === 'new' ? 'NEW' : 'USED_EXCELLENT',
        ...(item.condition !== 'new' && { conditionDescription: CONDITION_TEXT[item.condition] }),
        product: {
          title: item.title,
          description: item.description || item.title,
          aspects,
          imageUrls: item.photos.slice(0, MAX_PHOTOS).map((p) => imageUrls[p.id]),
          ...(item.brand && { brand: item.brand }),
        },
        ...(item.weight_oz && { packageWeightAndSize: { weight: { value: item.weight_oz, unit: 'OUNCE' } } }),
      },
    });

    // 4. Offer: price, category, policies. Updating a published offer revises the live listing.
    const offerBody = {
      availableQuantity: item.quantity,
      categoryId,
      listingDescription: htmlDescription(item.description || item.title),
      listingPolicies: {
        fulfillmentPolicyId: settings.fulfillmentPolicyId,
        paymentPolicyId: settings.paymentPolicyId,
        returnPolicyId: settings.returnPolicyId,
      },
      merchantLocationKey: settings.merchantLocationKey,
      pricingSummary: { price: { value: (item.price_cents / 100).toFixed(2), currency: config.ebay.currency } },
    };

    const existing = await findOffer(item.sku);
    let offerId: string;
    let listingId: string | undefined;
    if (existing) {
      offerId = existing.offerId;
      await ebayRequest('PUT', `${INVENTORY}/offer/${offerId}`, { body: offerBody });
      if (existing.status === 'PUBLISHED') listingId = existing.listing?.listingId;
    } else {
      const created = await ebayRequest<{ offerId: string }>('POST', `${INVENTORY}/offer`, {
        body: { sku: item.sku, marketplaceId: config.ebay.marketplaceId, format: 'FIXED_PRICE', ...offerBody },
      });
      offerId = created.data.offerId;
    }
    ctx.report({ meta: { offerId, categoryId } });

    // 5. Publish.
    if (!listingId) {
      const published = await ebayRequest<{ listingId: string }>('POST', `${INVENTORY}/offer/${offerId}/publish`);
      listingId = published.data.listingId;
    } else {
      notes.push('Updated the existing listing');
    }

    return {
      external_id: listingId,
      url: `${ebayHosts().web}/itm/${listingId}`,
      message: notes.join(' · ') || null,
      meta: { offerId, categoryId, imageUrls },
    };
  },

  async delist(_item, listing) {
    const offerId = listing.meta.offerId;
    if (typeof offerId !== 'string') throw new Error('No eBay offer ID stored for this listing');
    await ebayRequest('POST', `${INVENTORY}/offer/${offerId}/withdraw`);
  },
};
