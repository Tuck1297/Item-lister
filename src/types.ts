export const PLATFORMS = ['ebay', 'facebook', 'poshmark'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const CONDITIONS = ['new', 'like_new', 'good', 'fair', 'poor'] as const;
export type Condition = (typeof CONDITIONS)[number];

export type ListingStatus =
  | 'queued'
  | 'posting'
  | 'awaiting_review'
  | 'listed'
  | 'failed'
  | 'delisted'
  | 'delist_manually';

export const BUSY_STATUSES: readonly ListingStatus[] = ['queued', 'posting', 'awaiting_review'];

export interface Item {
  id: number;
  sku: string;
  title: string;
  description: string;
  price_cents: number;
  /** Poshmark requires an "original price"; falls back to the listing price. */
  original_price_cents: number | null;
  quantity: number;
  condition: Condition;
  brand: string;
  size: string;
  color: string;
  weight_oz: number | null;
  /** Leave blank to let eBay suggest one from the title. */
  ebay_category_id: string;
  /** eBay item specifics, one "Name: value" per line. */
  ebay_aspects: string;
  facebook_category: string;
  /** e.g. "Women > Tops > Blouses" */
  poshmark_category: string;
  status: 'active' | 'sold';
  created_at: string;
  updated_at: string;
}

export type ItemInput = Omit<Item, 'id' | 'status' | 'created_at' | 'updated_at'>;

export interface Photo {
  id: number;
  item_id: number;
  filename: string;
  position: number;
}

export interface Listing {
  id: number;
  item_id: number;
  platform: Platform;
  status: ListingStatus;
  external_id: string | null;
  url: string | null;
  message: string | null;
  meta: Record<string, unknown>;
  updated_at: string;
}

export interface ListingPatch {
  status?: ListingStatus;
  external_id?: string | null;
  url?: string | null;
  message?: string | null;
  /** Merged into the existing meta. */
  meta?: Record<string, unknown>;
}

export interface ItemFull extends Item {
  photos: Photo[];
  listings: Listing[];
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
