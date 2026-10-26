import type { Page } from 'playwright';
import { photoPath } from '../db';
import type { Condition } from '../types';
import { anyOf, exactText, fillField, FormFiller, getContext, handOff, pause, wholeDollars } from './browser';
import type { Publisher } from './types';

/*
 * Poshmark has no public listing API, so this drives poshmark.com/create-listing in a
 * real browser. Selectors are all in this file; when Poshmark changes its markup,
 * fix them here.
 */

const CREATE_URL = 'https://poshmark.com/create-listing';
const MAX_PHOTOS = 16;

const CONDITION_LABELS: Record<Condition, string> = {
  new: 'New With Tags',
  like_new: 'Like New',
  good: 'Good',
  fair: 'Fair',
  poor: 'Fair',
};

/** The open dropdown menu, wherever Poshmark renders it. */
function menu(page: Page) {
  return page.locator('.dropdown__menu--expanded, [role="listbox"], [role="menu"]').first();
}

async function pickFromDropdown(page: Page, trigger: string, values: string[]): Promise<void> {
  await anyOf(
    page.locator(`[data-et-name="${trigger}"]`),
    page.locator(`[data-test="${trigger}"]`),
  ).click({ timeout: 10_000 });
  for (const value of values) {
    await pause(400, 900);
    const name = exactText(value);
    await anyOf(
      menu(page).getByText(name),
      page.locator('[data-et-name="subcategory"], .listing-editor__subcategory-container').getByText(name),
      page.getByText(name),
    ).click({ timeout: 8_000 });
  }
  // Some pickers (size, color) need an explicit confirm.
  const done = page.getByRole('button', { name: /^(done|save|apply)$/i });
  if (await done.first().isVisible().catch(() => false)) await done.first().click();
}

async function assertLoggedIn(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await pause(1500, 2500);
  if (new URL(page.url()).pathname.startsWith('/login')) {
    throw new Error('Not logged in to Poshmark. Run `npm run login -- poshmark`, log in, then close that window');
  }
}

export const poshmark: Publisher = {
  platform: 'poshmark',
  label: 'Poshmark',

  async publish(item, ctx) {
    if (!item.photos.length) throw new Error('Poshmark needs at least one photo');

    const context = await getContext('poshmark');
    const page = await context.newPage();
    await page.goto(CREATE_URL, { waitUntil: 'domcontentloaded' });
    await assertLoggedIn(page);

    const form = new FormFiller(page);
    const photos = item.photos.slice(0, MAX_PHOTOS).map(photoPath);
    if (item.photos.length > MAX_PHOTOS) form.notes.push(`Only the first ${MAX_PHOTOS} photos were added`);

    await form.step('Photos', async () => {
      await page.locator('input[type="file"]').first().setInputFiles(photos);
      await pause(2000, 3000);
      // Poshmark opens a crop/filter editor after upload.
      const apply = page.getByRole('button', { name: /^apply$/i });
      if (await apply.isVisible().catch(() => false)) await apply.click();
    });

    await form.step('Title', () =>
      fillField(
        anyOf(page.locator('input[data-vv-name="title"]'), page.getByPlaceholder(/what are you selling/i)),
        item.title,
      ),
    );
    await form.step('Description', () =>
      fillField(
        anyOf(page.locator('textarea[data-vv-name="description"]'), page.getByPlaceholder(/describe it/i)),
        item.description || item.title,
      ),
    );

    const category = item.poshmark_category
      .split('>')
      .map((s) => s.trim())
      .filter(Boolean);
    if (category.length) {
      await form.step('Category', () => pickFromDropdown(page, 'category', category));
    } else {
      form.warnings.push('Category: none set on the item (e.g. "Women > Tops > Blouses"), so pick one');
    }

    if (item.size) await form.step('Size', () => pickFromDropdown(page, 'size', [item.size]));
    else form.warnings.push('Size: none set on the item, so pick one');

    await form.step('Condition', () => pickFromDropdown(page, 'condition', [CONDITION_LABELS[item.condition]]));

    if (item.brand) {
      await form.step('Brand', async () => {
        await fillField(
          anyOf(page.locator('[data-vv-name="brand"] input, input[data-vv-name="brand"]'), page.getByPlaceholder(/brand/i)),
          item.brand,
        );
        await pause(800, 1400);
        const suggestion = menu(page).getByText(exactText(item.brand));
        if (await suggestion.first().isVisible().catch(() => false)) await suggestion.first().click();
      });
    }
    if (item.color) await form.step('Color', () => pickFromDropdown(page, 'color', [item.color]));

    await form.step('Original price', () =>
      fillField(
        anyOf(page.locator('input[data-vv-name="originalPrice"]'), page.getByPlaceholder(/original price/i)),
        wholeDollars(item.original_price_cents ?? item.price_cents, form.notes, 'Poshmark original price'),
      ),
    );
    await form.step('Listing price', () =>
      fillField(
        anyOf(page.locator('input[data-vv-name="listingPrice"]'), page.getByPlaceholder(/listing price/i)),
        wholeDollars(item.price_cents, form.notes, 'Poshmark listing price'),
      ),
    );

    const mode = await handOff({
      page,
      siteName: 'Poshmark',
      warnings: form.warnings,
      report: ctx.report,
      isPublished: (url) => !url.pathname.startsWith('/create-listing') && !url.pathname.startsWith('/login'),
      submit: async () => {
        await page.getByRole('button', { name: exactText('Next') }).click({ timeout: 10_000 });
        await pause(1500, 2500);
        await anyOf(
          page.locator('[data-et-name="list_item"]'),
          page.getByRole('button', { name: /^list (this )?item$/i }),
        ).click({ timeout: 15_000 });
      },
    });

    const url = page.url();
    const id = url.match(/\/listing\/[^/?#]*-([0-9a-f]{16,})/i)?.[1] ?? null;
    await page.close().catch(() => {});
    return {
      external_id: id,
      url: id ? url : 'https://poshmark.com/closet',
      message: [mode === 'review' && 'Published after your review', ...form.notes].filter(Boolean).join(' · ') || null,
    };
  },
};
