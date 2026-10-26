import type { ItemFull, Listing, ListingPatch, Platform } from '../types';

export interface PublishContext {
  /** The listing row from the previous attempt, if any (holds cached eBay offer/image IDs). */
  previous: Listing | undefined;
  /** Push an interim update (e.g. "awaiting_review") while the job keeps running. */
  report(patch: ListingPatch): void;
}

export interface PublishResult {
  external_id?: string | null;
  url?: string | null;
  message?: string | null;
  meta?: Record<string, unknown>;
}

export interface Publisher {
  platform: Platform;
  label: string;
  /** Resolves once the item is live; throws with a human-readable message otherwise. */
  publish(item: ItemFull, ctx: PublishContext): Promise<PublishResult>;
  /** Ends the live listing. Platforms without this get flagged "delist manually". */
  delist?(item: ItemFull, listing: Listing): Promise<void>;
}
