import fs from 'node:fs';
import path from 'node:path';

try {
  process.loadEnvFile();
} catch {
  // No .env file — fall back to real environment variables.
}

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.resolve(root, env('DATA_DIR', 'data'));

export const config = {
  host: env('HOST', '127.0.0.1'),
  port: Number(env('PORT', '3000')),

  /** "review" fills the Facebook/Poshmark forms and waits for you to click Publish; "auto" clicks it too. */
  postMode: (env('POST_MODE', 'review') === 'auto' ? 'auto' : 'review') as 'auto' | 'review',
  /** How long a browser tab waits for you to publish in review mode. */
  reviewTimeoutMs: Number(env('REVIEW_TIMEOUT_MINUTES', '15')) * 60_000,
  headless: env('HEADLESS', 'false') === 'true',
  /** "chrome" drives your installed Google Chrome (less likely to be flagged); "chromium" uses Playwright's bundled build. */
  browserChannel: env('BROWSER_CHANNEL', 'chrome'),

  root,
  publicDir: path.join(root, 'public'),
  dataDir,
  dbPath: path.join(dataDir, 'crosslister.db'),
  uploadsDir: path.join(dataDir, 'uploads'),
  profilesDir: path.join(dataDir, 'profiles'),

  ebay: {
    env: (env('EBAY_ENV', 'sandbox') === 'production' ? 'production' : 'sandbox') as 'production' | 'sandbox',
    clientId: env('EBAY_CLIENT_ID'),
    clientSecret: env('EBAY_CLIENT_SECRET'),
    ruName: env('EBAY_RU_NAME'),
    marketplaceId: env('EBAY_MARKETPLACE_ID', 'EBAY_US'),
    currency: env('EBAY_CURRENCY', 'USD'),
    fulfillmentPolicyId: env('EBAY_FULFILLMENT_POLICY_ID'),
    paymentPolicyId: env('EBAY_PAYMENT_POLICY_ID'),
    returnPolicyId: env('EBAY_RETURN_POLICY_ID'),
    merchantLocationKey: env('EBAY_MERCHANT_LOCATION_KEY', 'home'),
    locationPostalCode: env('EBAY_LOCATION_POSTAL_CODE'),
    locationCountry: env('EBAY_LOCATION_COUNTRY', 'US'),
  },
};

for (const dir of [config.dataDir, config.uploadsDir, config.profilesDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
