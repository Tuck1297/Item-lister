import type { Condition, ItemFull, Listing, ListingStatus, Platform } from '../../src/types';

export type { Condition, ItemFull, Listing, ListingStatus, Platform };

export type Site = 'facebook' | 'poshmark';
export type PolicyKind = 'fulfillment' | 'payment' | 'return';

export interface AppConfig {
  postMode: 'auto' | 'review';
  platforms: { id: Platform; label: string }[];
  facebookCategories: string[];
}

export interface SiteConnection {
  site: Site;
  label: string;
  connected: boolean;
  checkedAt: string | null;
  /** A login window is open and we're waiting for you to finish. */
  loginOpen: boolean;
  message: string | null;
}

export interface EbayConnection {
  env: 'sandbox' | 'production';
  /** .env keys still missing (client ID, secret, RuName). */
  missingKeys: string[];
  connected: boolean;
  /** Policies still to choose after connecting. */
  missingSetup: string[];
  consentUrl: string | null;
  callbackUrl: string;
}

export interface Connections {
  sites: SiteConnection[];
  ebay: EbayConnection;
}

export interface EbaySetup {
  policies: Record<PolicyKind, { id: string; name: string }[]>;
  selected: {
    fulfillmentPolicyId: string;
    paymentPolicyId: string;
    returnPolicyId: string;
    merchantLocationKey: string;
  };
  location: { key: string; exists: boolean };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

const send = <T>(method: string, path: string, data?: unknown) =>
  request<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data ?? {}),
  });

export const api = {
  config: () => request<AppConfig>('/api/config'),

  items: () => request<ItemFull[]>('/api/items'),
  saveItem: (id: number | null, data: FormData) =>
    request<ItemFull>(id ? `/api/items/${id}` : '/api/items', { method: id ? 'PUT' : 'POST', body: data }),
  deleteItem: (id: number) => request<{ ok: true }>(`/api/items/${id}`, { method: 'DELETE' }),
  deletePhoto: (id: number, photoId: number) =>
    request<ItemFull>(`/api/items/${id}/photos/${photoId}`, { method: 'DELETE' }),
  makeCover: (id: number, photoId: number) => send<ItemFull>('POST', `/api/items/${id}/photos/${photoId}/cover`),
  post: (id: number, platforms: Platform[]) => send<ItemFull>('POST', `/api/items/${id}/post`, { platforms }),
  markSold: (id: number) => send<ItemFull>('POST', `/api/items/${id}/sold`),
  unmarkSold: (id: number) => send<ItemFull>('POST', `/api/items/${id}/relist`),
  markDelisted: (id: number, platform: Platform) =>
    send<ItemFull>('POST', `/api/items/${id}/listings/${platform}/delisted`),

  connections: () => request<Connections>('/api/connections'),
  login: (site: Site) => send<Connections>('POST', `/api/connections/${site}/login`),
  checkLogin: (site: Site) => send<Connections>('POST', `/api/connections/${site}/check`),
  logout: (site: Site) => send<Connections>('POST', `/api/connections/${site}/logout`),

  ebayConnect: (redirectUrl: string) => send<Connections>('POST', '/api/ebay/connect', { redirectUrl }),
  ebayDisconnect: () => send<Connections>('POST', '/api/ebay/disconnect'),
  ebaySetup: () => request<EbaySetup>('/api/ebay/setup'),
  saveEbaySetup: (patch: Partial<EbaySetup['selected']>) => send<EbaySetup>('PUT', '/api/ebay/setup', patch),
  createEbayLocation: (postalCode: string) => send<EbaySetup>('POST', '/api/ebay/location', { postalCode }),
  createDefaultPolicies: () => send<EbaySetup>('POST', '/api/ebay/default-policies'),
};

export const BUSY: ListingStatus[] = ['queued', 'posting', 'awaiting_review'];

export const STATUS: Record<ListingStatus, { label: string; color: string }> = {
  queued: { label: 'Queued', color: 'blue' },
  posting: { label: 'Posting', color: 'blue' },
  awaiting_review: { label: 'Review in browser', color: 'yellow' },
  listed: { label: 'Listed', color: 'green' },
  failed: { label: 'Failed', color: 'red' },
  delisted: { label: 'Delisted', color: 'gray' },
  delist_manually: { label: 'Delist manually', color: 'orange' },
};

export const CONDITIONS: { value: Condition; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'like_new', label: 'Like new' },
  { value: 'good', label: 'Good' },
  { value: 'fair', label: 'Fair' },
  { value: 'poor', label: 'Poor' },
];

export const money = (cents: number) =>
  `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
