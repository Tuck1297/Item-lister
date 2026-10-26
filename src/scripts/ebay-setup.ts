/**
 * Prepares your eBay account for API listings:
 *   - opts in to business policies
 *   - creates the inventory location items ship from
 *   - prints your shipping/payment/return policy IDs for .env
 *
 *   npm run ebay:setup                      # inspect + create the location
 *   npm run ebay:setup -- --create-policies # also create simple default policies (handy in sandbox)
 */
import { config } from '../config';
import { EbayApiError, ebayRequest, missingAppConfig } from '../platforms/ebay/client';

const ACCOUNT = '/sell/account/v1';
const marketplace = config.ebay.marketplaceId;
const createPolicies = process.argv.includes('--create-policies');

if (missingAppConfig().length) {
  console.error(`Set ${missingAppConfig().join(', ')} in .env, then run npm run ebay:auth.`);
  process.exit(1);
}

// 1. Business policies opt-in (required for the Inventory API).
try {
  await ebayRequest('POST', `${ACCOUNT}/program/opt_in`, { body: { programType: 'SELLING_POLICY_MANAGEMENT' } });
  console.log('✓ Opted in to business policies');
} catch (err) {
  console.log(`• Business policies opt-in: ${err instanceof Error ? err.message : err} (usually means already opted in)`);
}

// 2. Inventory location.
const key = config.ebay.merchantLocationKey;
try {
  await ebayRequest('GET', `/sell/inventory/v1/location/${encodeURIComponent(key)}`);
  console.log(`✓ Inventory location "${key}" exists`);
} catch (err) {
  if (!(err instanceof EbayApiError) || err.status !== 404) throw err;
  if (!config.ebay.locationPostalCode) {
    console.log(`✗ No inventory location "${key}". Set EBAY_LOCATION_POSTAL_CODE in .env and re-run.`);
  } else {
    await ebayRequest('POST', `/sell/inventory/v1/location/${encodeURIComponent(key)}`, {
      body: {
        name: 'Home',
        locationTypes: ['WAREHOUSE'],
        location: { address: { postalCode: config.ebay.locationPostalCode, country: config.ebay.locationCountry } },
      },
    });
    console.log(`✓ Created inventory location "${key}" (${config.ebay.locationPostalCode})`);
  }
}

// 3. Policies.
const categoryTypes = [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }];
const defaults = {
  fulfillment: {
    name: 'Crosslister shipping',
    marketplaceId: marketplace,
    categoryTypes,
    handlingTime: { value: 3, unit: 'DAY' },
    shippingOptions: [
      {
        optionType: 'DOMESTIC',
        costType: 'FLAT_RATE',
        shippingServices: [
          {
            shippingCarrierCode: 'USPS',
            shippingServiceCode: 'USPSGroundAdvantage',
            shippingCost: { value: '0.00', currency: config.ebay.currency },
            freeShipping: true,
            sortOrder: 1,
          },
        ],
      },
    ],
  },
  payment: { name: 'Crosslister payment', marketplaceId: marketplace, categoryTypes, immediatePay: true },
  return: {
    name: 'Crosslister returns',
    marketplaceId: marketplace,
    categoryTypes,
    returnsAccepted: true,
    returnPeriod: { value: 30, unit: 'DAY' },
    returnShippingCostPayer: 'BUYER',
  },
};

const envKeys = { fulfillment: 'EBAY_FULFILLMENT_POLICY_ID', payment: 'EBAY_PAYMENT_POLICY_ID', return: 'EBAY_RETURN_POLICY_ID' };
const chosen: Record<string, string> = {};

for (const kind of ['fulfillment', 'payment', 'return'] as const) {
  const res = await ebayRequest<Record<string, { name: string; [id: string]: string }[] | undefined>>(
    'GET',
    `${ACCOUNT}/${kind}_policy?marketplace_id=${marketplace}`,
  );
  const policies = res.data[`${kind}Policies`] ?? [];
  const idKey = `${kind}PolicyId`;

  if (!policies.length && createPolicies) {
    const created = await ebayRequest<Record<string, string>>('POST', `${ACCOUNT}/${kind}_policy`, {
      body: defaults[kind],
    });
    console.log(`✓ Created ${kind} policy "${defaults[kind].name}"`);
    chosen[envKeys[kind]] = created.data[idKey]!;
    continue;
  }

  console.log(`\n${kind} policies:`);
  if (!policies.length) console.log('  (none: create one in Seller Hub, or re-run with --create-policies)');
  for (const p of policies) console.log(`  ${p[idKey]}  ${p.name}`);
  if (policies[0]) chosen[envKeys[kind]] = policies[0][idKey]!;
}

console.log('\nAdd to .env (swap IDs if you prefer a different policy above):\n');
for (const [k, v] of Object.entries(chosen)) console.log(`${k}=${v}`);
console.log(`EBAY_MERCHANT_LOCATION_KEY=${key}`);
