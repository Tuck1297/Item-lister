import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config';

export const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
];

export function ebayHosts() {
  return config.ebay.env === 'production'
    ? { api: 'https://api.ebay.com', auth: 'https://auth.ebay.com', media: 'https://apim.ebay.com', web: 'https://www.ebay.com' }
    : {
        api: 'https://api.sandbox.ebay.com',
        auth: 'https://auth.sandbox.ebay.com',
        media: 'https://apim.sandbox.ebay.com',
        web: 'https://sandbox.ebay.com',
      };
}

/** Keys needed to talk to eBay at all. */
export function missingAppConfig(): string[] {
  const { clientId, clientSecret, ruName } = config.ebay;
  return Object.entries({ EBAY_CLIENT_ID: clientId, EBAY_CLIENT_SECRET: clientSecret, EBAY_RU_NAME: ruName })
    .filter(([, v]) => !v)
    .map(([k]) => k);
}

/** Business policies needed before an offer can be published (`npm run ebay:setup` prints these). */
export function missingListingConfig(): string[] {
  const { fulfillmentPolicyId, paymentPolicyId, returnPolicyId } = config.ebay;
  return Object.entries({
    EBAY_FULFILLMENT_POLICY_ID: fulfillmentPolicyId,
    EBAY_PAYMENT_POLICY_ID: paymentPolicyId,
    EBAY_RETURN_POLICY_ID: returnPolicyId,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
}

// ---------- OAuth ----------

interface StoredToken {
  refresh_token: string;
  refresh_token_expires_at: number;
  access_token?: string;
  access_token_expires_at?: number;
}

const tokenFile = () => path.join(config.dataDir, `ebay-token.${config.ebay.env}.json`);

function readToken(): StoredToken | undefined {
  try {
    return JSON.parse(fs.readFileSync(tokenFile(), 'utf8')) as StoredToken;
  } catch {
    return undefined;
  }
}

function writeToken(token: StoredToken): void {
  fs.writeFileSync(tokenFile(), JSON.stringify(token, null, 2), { mode: 0o600 });
}

export function isConnected(): boolean {
  const token = readToken();
  return !!token && token.refresh_token_expires_at > Date.now();
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const basic = Buffer.from(`${config.ebay.clientId}:${config.ebay.clientSecret}`).toString('base64');
  const res = await fetch(`${ebayHosts().api}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams(params),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok) {
    throw new Error(`eBay token request failed (${res.status}): ${body.error_description ?? body.error ?? res.statusText}`);
  }
  return body as unknown as TokenResponse;
}

export function consentUrl(): string {
  const params = new URLSearchParams({
    client_id: config.ebay.clientId,
    response_type: 'code',
    redirect_uri: config.ebay.ruName,
    scope: EBAY_SCOPES.join(' '),
  });
  return `${ebayHosts().auth}/oauth2/authorize?${params}`;
}

export async function exchangeCode(code: string): Promise<void> {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: config.ebay.ruName });
  if (!t.refresh_token) throw new Error('eBay did not return a refresh token');
  writeToken({
    refresh_token: t.refresh_token,
    refresh_token_expires_at: Date.now() + (t.refresh_token_expires_in ?? 0) * 1000,
    access_token: t.access_token,
    access_token_expires_at: Date.now() + t.expires_in * 1000,
  });
}

async function userToken(): Promise<string> {
  const stored = readToken();
  if (!stored) throw new Error("eBay isn't connected yet. Run `npm run ebay:auth`");
  if (stored.refresh_token_expires_at < Date.now()) {
    throw new Error('The eBay authorization expired (they last ~18 months). Run `npm run ebay:auth` again');
  }
  if (stored.access_token && (stored.access_token_expires_at ?? 0) > Date.now() + 60_000) return stored.access_token;

  const t = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: stored.refresh_token,
    scope: EBAY_SCOPES.join(' '),
  });
  writeToken({ ...stored, access_token: t.access_token, access_token_expires_at: Date.now() + t.expires_in * 1000 });
  return t.access_token;
}

let appTokenCache: { token: string; expiresAt: number } | undefined;

/** Application token for public APIs like Taxonomy. */
async function appToken(): Promise<string> {
  if (appTokenCache && appTokenCache.expiresAt > Date.now() + 60_000) return appTokenCache.token;
  const t = await tokenRequest({ grant_type: 'client_credentials', scope: EBAY_SCOPES[0]! });
  appTokenCache = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
  return t.access_token;
}

// ---------- Requests ----------

export interface EbayErrorDetail {
  errorId?: number;
  message?: string;
  longMessage?: string;
  parameters?: { name: string; value: string }[];
}

export class EbayApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errors: EbayErrorDetail[],
  ) {
    super(message);
  }
}

interface RequestOptions {
  body?: unknown;
  form?: FormData;
  auth?: 'user' | 'app';
}

export async function ebayRequest<T = unknown>(
  method: string,
  pathOrUrl: string,
  opts: RequestOptions = {},
): Promise<{ status: number; headers: Headers; data: T }> {
  const token = opts.auth === 'app' ? await appToken() : await userToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : ebayHosts().api + pathOrUrl;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Accept-Language': 'en-US',
    'X-EBAY-C-MARKETPLACE-ID': config.ebay.marketplaceId,
  };
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Language'] = 'en-US';
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const errors = ((data as { errors?: EbayErrorDetail[] })?.errors ?? []) as EbayErrorDetail[];
    const detail = errors.map((e) => e.longMessage || e.message).filter(Boolean).join(' | ');
    throw new EbayApiError(res.status, `eBay: ${detail || `${res.status} ${res.statusText}`}`, errors);
  }
  return { status: res.status, headers: res.headers, data: data as T };
}
