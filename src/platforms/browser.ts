import path from 'node:path';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { config } from '../config';
import type { ListingPatch } from '../types';

export type Profile = 'facebook' | 'poshmark';

const open = new Map<Profile, Promise<BrowserContext>>();

export class NotLoggedInError extends Error {}

export function profileDir(profile: Profile): string {
  return path.join(config.profilesDir, profile);
}

/**
 * One persistent browser profile per site, so your logins survive restarts.
 * Profiles live in data/profiles/<site>; log in from the Connections panel in the UI.
 */
export function getContext(profile: Profile): Promise<BrowserContext> {
  let pending = open.get(profile);
  if (!pending) {
    pending = launch(profile, config.headless);
    open.set(profile, pending);
    pending.then(
      (ctx) => ctx.on('close', () => open.delete(profile)),
      () => open.delete(profile),
    );
  }
  return pending;
}

/** A tab to work in: the blank one a fresh browser starts with, or a new one. */
export async function newTab(context: BrowserContext): Promise<Page> {
  return context.pages().find((p) => p.url() === 'about:blank') ?? context.newPage();
}

/** The profile's browser if it's already running, without launching one. */
export async function openContext(profile: Profile): Promise<BrowserContext | undefined> {
  return open.get(profile)?.catch(() => undefined);
}

export async function closeContext(profile: Profile): Promise<void> {
  const ctx = await openContext(profile);
  await ctx?.close().catch(() => {});
}

/**
 * Runs fn against the profile without showing a window: reuses the open browser if
 * there is one, otherwise starts a short-lived headless one on the same profile.
 */
export async function withQuietContext<T>(profile: Profile, fn: (ctx: BrowserContext) => Promise<T>): Promise<T> {
  const existing = await openContext(profile);
  if (existing) return fn(existing);
  const ctx = await launch(profile, true);
  try {
    return await fn(ctx);
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function launch(profile: Profile, headless: boolean): Promise<BrowserContext> {
  const userDataDir = profileDir(profile);
  const options = {
    headless,
    viewport: null,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  };
  const channel = config.browserChannel;
  if (channel && channel !== 'chromium') {
    try {
      return await chromium.launchPersistentContext(userDataDir, { ...options, channel });
    } catch (err) {
      console.warn(`[browser] couldn't launch "${channel}", using bundled Chromium: ${shortError(err)}`);
    }
  }
  return chromium.launchPersistentContext(userDataDir, options);
}

export function shortError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0]!.replace(/^locator\.\w+: /, '');
}

/** Random pause so we don't hammer forms faster than a person could. */
export function pause(minMs = 400, maxMs = 1100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, minMs + Math.random() * (maxMs - minMs)));
}

/** First match among several candidate selectors — sites change markup, so each field gets fallbacks. */
export function anyOf(...candidates: Locator[]): Locator {
  return candidates.reduce((a, b) => a.or(b)).first();
}

export function exactText(text: string): RegExp {
  return new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
}

/** Whole dollars only — both Facebook and Poshmark reject cents. */
export function wholeDollars(cents: number, notes: string[], label: string): string {
  const dollars = Math.round(cents / 100);
  if (cents % 100 !== 0) notes.push(`${label} rounded to $${dollars} (whole dollars only)`);
  return String(dollars);
}

/**
 * Runs each form step independently: a broken selector becomes a warning
 * (and forces review mode) instead of failing the whole listing.
 */
export class FormFiller {
  /** Fields that couldn't be filled; any of these forces review mode. */
  readonly warnings: string[] = [];
  /** FYIs that don't block auto-publish (e.g. price rounding). */
  readonly notes: string[] = [];

  constructor(readonly page: Page) {}

  async step(label: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      await pause();
      return true;
    } catch (err) {
      this.warnings.push(`${label}: ${shortError(err)}`);
      return false;
    }
  }
}

export async function fillField(field: Locator, value: string): Promise<void> {
  await field.waitFor({ state: 'visible', timeout: 10_000 });
  await field.click();
  await field.fill(value);
}

interface HandOffOptions {
  page: Page;
  siteName: string;
  warnings: string[];
  /** Clicks through to publish (auto mode). */
  submit: () => Promise<void>;
  /** True once the page shows the listing went live. */
  isPublished: (url: URL) => boolean;
  report: (patch: ListingPatch) => void;
}

/**
 * Review mode (default) or any warnings: leave the tab open and wait for you to click Publish.
 * Auto mode with a clean fill: click Publish ourselves.
 */
export async function handOff(opts: HandOffOptions): Promise<'auto' | 'review'> {
  const { page, siteName, warnings } = opts;
  let mode: 'auto' | 'review' = config.postMode === 'auto' && warnings.length === 0 ? 'auto' : 'review';

  if (mode === 'auto') {
    try {
      await opts.submit();
    } catch (err) {
      warnings.push(`Auto-publish: ${shortError(err)}`);
      mode = 'review';
    }
  }

  if (mode === 'review') {
    const why = warnings.length
      ? `Fix ${warnings.length} field(s) then click Publish: ${warnings.join(' · ')}`
      : 'Check the form, then click Publish in the browser window';
    opts.report({ status: 'awaiting_review', message: why });
    await showBanner(page, `Item Lister: review this ${siteName} listing, then publish it.`, warnings);
    if (!config.headless) await page.bringToFront().catch(() => {});
  }

  const outcome = await waitFor(page, opts.isPublished, mode === 'auto' ? 90_000 : config.reviewTimeoutMs);
  if (outcome === 'closed') throw new Error(`The ${siteName} tab was closed before the listing was published`);
  if (outcome === 'timeout') {
    throw new Error(
      mode === 'auto'
        ? `Clicked publish on ${siteName} but never saw it go live. Check the browser window`
        : `Timed out waiting for you to publish on ${siteName}`,
    );
  }
  return mode;
}

async function waitFor(
  page: Page,
  isPublished: (url: URL) => boolean,
  timeoutMs: number,
): Promise<'published' | 'closed' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) return 'closed';
    if (isPublished(new URL(page.url()))) return 'published';
    await new Promise((r) => setTimeout(r, 1000));
  }
  return 'timeout';
}

async function showBanner(page: Page, title: string, warnings: string[]): Promise<void> {
  await page
    .evaluate(
      ({ title, warnings }) => {
        document.getElementById('item-lister-banner')?.remove();
        const el = document.createElement('div');
        el.id = 'item-lister-banner';
        el.style.cssText =
          'position:fixed;bottom:16px;left:16px;z-index:2147483647;max-width:420px;padding:12px 14px;' +
          'background:#111827;color:#f9fafb;font:13px/1.4 system-ui,sans-serif;border-radius:10px;' +
          'box-shadow:0 8px 24px rgba(0,0,0,.35);cursor:pointer';
        el.title = 'Click to dismiss';
        el.onclick = () => el.remove();
        const heading = document.createElement('strong');
        heading.textContent = title;
        el.append(heading);
        for (const w of warnings) {
          const line = document.createElement('div');
          line.style.cssText = 'margin-top:6px;color:#fca5a5';
          line.textContent = `• ${w}`;
          el.append(line);
        }
        document.body.append(el);
      },
      { title, warnings },
    )
    .catch(() => {});
}
