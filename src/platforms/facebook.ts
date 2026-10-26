import type { Page } from 'playwright';
import { photoPath } from '../db';
import type { Condition } from '../types';
import { anyOf, exactText, fillField, FormFiller, getContext, handOff, pause, wholeDollars } from './browser';
import type { Publisher } from './types';

/*
 * Facebook has no listing API for individuals, so this drives the "Create new listing"
 * form in a real browser. Selectors are all in this file; when Facebook changes its
 * markup, fix them here. Assumes Facebook's UI language is English.
 */

const CREATE_URL = 'https://www.facebook.com/marketplace/create/item';
const MAX_PHOTOS = 10;

export const FACEBOOK_CATEGORIES = [
  'Tools',
  'Furniture',
  'Household',
  'Garden',
  'Appliances',
  'Video Games',
  'Books, Movies & Music',
  'Bags & Luggage',
  "Women's Clothing & Shoes",
  "Men's Clothing & Shoes",
  'Jewelry & Accessories',
  'Health & Beauty',
  'Pet Supplies',
  'Baby & Kids',
  'Toys & Games',
  'Electronics & Computers',
  'Mobile Phones',
  'Bicycles',
  'Arts & Crafts',
  'Sports & Outdoors',
  'Auto Parts',
  'Musical Instruments',
  'Antiques & Collectibles',
  'Garage Sale',
  'Miscellaneous',
];

const CONDITION_LABELS: Record<Condition, string> = {
  new: 'New',
  like_new: 'Used - Like New',
  good: 'Used - Good',
  fair: 'Used - Fair',
  poor: 'Used - Fair',
};

/** Facebook labels inputs with visible text, so look fields up by accessible name. */
function field(page: Page, label: string) {
  return anyOf(
    page.getByLabel(label, { exact: true }),
    page.getByRole('textbox', { name: label, exact: true }),
    page.getByRole('combobox', { name: label, exact: true }),
  );
}

async function choose(page: Page, label: string, option: string): Promise<void> {
  await field(page, label).click({ timeout: 10_000 });
  await pause(300, 700);
  const name = exactText(option);
  await anyOf(
    page.getByRole('option', { name }),
    page.getByRole('menuitemradio', { name }),
    page.getByRole('radio', { name }),
    page.getByRole('button', { name }),
  ).click({ timeout: 8_000 });
}

async function assertLoggedIn(page: Page): Promise<void> {
  const loginForm = page.locator('input[name="email"], form[action*="login"]').first();
  const photoInput = page.locator('input[type="file"]').first();
  await anyOf(photoInput, loginForm).waitFor({ state: 'attached', timeout: 30_000 });
  if (page.url().includes('/login') || (await loginForm.count()) > 0) {
    throw new Error('Not logged in to Facebook. Run `npm run login -- facebook`, log in, then close that window');
  }
}

export const facebook: Publisher = {
  platform: 'facebook',
  label: 'Facebook Marketplace',

  async publish(item, ctx) {
    if (!item.photos.length) throw new Error('Facebook needs at least one photo');

    const context = await getContext('facebook');
    const page = await context.newPage();
    await page.goto(CREATE_URL, { waitUntil: 'domcontentloaded' });
    await assertLoggedIn(page);

    const form = new FormFiller(page);
    const photos = item.photos.slice(0, MAX_PHOTOS).map(photoPath);
    if (item.photos.length > MAX_PHOTOS) form.notes.push(`Only the first ${MAX_PHOTOS} photos were added`);

    await form.step('Photos', async () => {
      await page.locator('input[type="file"][accept*="image"]').first().setInputFiles(photos);
      await pause(2000, 3500); // let the previews upload
    });
    await form.step('Title', () => fillField(field(page, 'Title'), item.title));
    await form.step('Price', () =>
      fillField(field(page, 'Price'), wholeDollars(item.price_cents, form.notes, 'Facebook price')),
    );
    if (item.facebook_category) {
      await form.step('Category', () => choose(page, 'Category', item.facebook_category));
    } else {
      form.warnings.push('Category: none set on the item, so pick one');
    }
    await form.step('Condition', () => choose(page, 'Condition', CONDITION_LABELS[item.condition]));
    await form.step('Description', () => fillField(field(page, 'Description'), item.description || item.title));

    // Clothing categories reveal extra fields; fill them only if they appeared.
    if (item.size && (await field(page, 'Size').isVisible().catch(() => false))) {
      await form.step('Size', () => fillField(field(page, 'Size'), item.size));
    }
    if (item.brand && (await field(page, 'Brand').isVisible().catch(() => false))) {
      await form.step('Brand', () => fillField(field(page, 'Brand'), item.brand));
    }

    const mode = await handOff({
      page,
      siteName: 'Facebook',
      warnings: form.warnings,
      report: ctx.report,
      isPublished: (url) => !url.pathname.startsWith('/marketplace/create'),
      submit: async () => {
        // Facebook sometimes inserts a "Next" step (delivery options, groups) before "Publish".
        for (let i = 0; i < 3; i++) {
          const next = page.getByRole('button', { name: exactText('Next') });
          if (!(await next.isVisible().catch(() => false))) break;
          await next.click();
          await pause(1500, 2500);
        }
        await page.getByRole('button', { name: exactText('Publish') }).click({ timeout: 15_000 });
      },
    });

    await page.close().catch(() => {});
    return {
      url: 'https://www.facebook.com/marketplace/you/selling',
      message: [mode === 'review' && 'Published after your review', ...form.notes].filter(Boolean).join(' · ') || null,
    };
  },
};
