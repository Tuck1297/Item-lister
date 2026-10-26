import { config } from '../../config';
import { EbayApiError, ebayRequest, listingSettings, saveListingSettings, type ListingSettings } from './client';

/*
 * Account setup the Inventory API needs before anything can be listed:
 * business policies (shipping, payment, returns) and a ship-from location.
 */

const ACCOUNT = '/sell/account/v1';
const KINDS = ['fulfillment', 'payment', 'return'] as const;
type PolicyKind = (typeof KINDS)[number];

export interface PolicySummary {
  id: string;
  name: string;
}

export interface EbaySetupStatus {
  policies: Record<PolicyKind, PolicySummary[]>;
  selected: ListingSettings;
  location: { key: string; exists: boolean };
}

async function optIn(): Promise<void> {
  await ebayRequest('POST', `${ACCOUNT}/program/opt_in`, { body: { programType: 'SELLING_POLICY_MANAGEMENT' } }).catch(
    () => {}, // already opted in
  );
}

async function listPolicies(kind: PolicyKind): Promise<PolicySummary[]> {
  const res = await ebayRequest<Record<string, Record<string, string>[] | undefined>>(
    'GET',
    `${ACCOUNT}/${kind}_policy?marketplace_id=${config.ebay.marketplaceId}`,
  );
  return (res.data[`${kind}Policies`] ?? []).map((p) => ({ id: p[`${kind}PolicyId`]!, name: p.name ?? '(unnamed)' }));
}

async function locationExists(key: string): Promise<boolean> {
  try {
    await ebayRequest('GET', `/sell/inventory/v1/location/${encodeURIComponent(key)}`);
    return true;
  } catch (err) {
    if (err instanceof EbayApiError && err.status === 404) return false;
    throw err;
  }
}

export async function getSetupStatus(): Promise<EbaySetupStatus> {
  let lists: PolicySummary[][];
  try {
    lists = await Promise.all(KINDS.map(listPolicies));
  } catch (err) {
    // Accounts that never opted in to business policies get an error here.
    if (!(err instanceof EbayApiError)) throw err;
    await optIn();
    lists = await Promise.all(KINDS.map(listPolicies));
  }
  const policies = Object.fromEntries(KINDS.map((k, i) => [k, lists[i]!])) as Record<PolicyKind, PolicySummary[]>;

  // First visit: pre-select when there's only one option of each kind.
  const selected = listingSettings();
  const autoPick: Partial<ListingSettings> = {};
  for (const kind of KINDS) {
    const key = `${kind}PolicyId` as const;
    if (!selected[key] && policies[kind].length === 1) autoPick[key] = policies[kind][0]!.id;
  }
  if (Object.keys(autoPick).length) saveListingSettings(autoPick);

  const final = listingSettings();
  return { policies, selected: final, location: { key: final.merchantLocationKey, exists: await locationExists(final.merchantLocationKey) } };
}

export async function createLocation(postalCode: string, country = config.ebay.locationCountry): Promise<void> {
  const key = listingSettings().merchantLocationKey;
  await ebayRequest('POST', `/sell/inventory/v1/location/${encodeURIComponent(key)}`, {
    body: { name: 'Home', locationTypes: ['WAREHOUSE'], location: { address: { postalCode, country } } },
  });
}

/** Simple starter policies (handy for sandbox accounts, which have none). Only creates kinds that are missing. */
export async function createDefaultPolicies(): Promise<void> {
  const marketplaceId = config.ebay.marketplaceId;
  const categoryTypes = [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }];
  const bodies: Record<PolicyKind, Record<string, unknown>> = {
    fulfillment: {
      name: 'Item Lister shipping',
      marketplaceId,
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
    payment: { name: 'Item Lister payment', marketplaceId, categoryTypes, immediatePay: true },
    return: {
      name: 'Item Lister returns',
      marketplaceId,
      categoryTypes,
      returnsAccepted: true,
      returnPeriod: { value: 30, unit: 'DAY' },
      returnShippingCostPayer: 'BUYER',
    },
  };

  await optIn();
  for (const kind of KINDS) {
    if ((await listPolicies(kind)).length) continue;
    const created = await ebayRequest<Record<string, string>>('POST', `${ACCOUNT}/${kind}_policy`, { body: bodies[kind] });
    saveListingSettings({ [`${kind}PolicyId`]: created.data[`${kind}PolicyId`] });
  }
}
