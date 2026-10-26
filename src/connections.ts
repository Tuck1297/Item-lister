import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { config } from './config';
import { closeContext, getContext, profileDir, shortError, withQuietContext, type Profile } from './platforms/browser';
import { HttpError } from './types';

/*
 * Facebook and Poshmark logins happen in a real browser window, opened from the UI.
 * We watch the session cookies to notice when you've logged in, then close the window.
 * The login lives in that site's browser profile (data/profiles/<site>).
 */

interface Site {
  label: string;
  loginUrl: string;
  isLoggedIn(ctx: BrowserContext, page?: Page): Promise<boolean>;
}

export const SITES: Record<Profile, Site> = {
  facebook: {
    label: 'Facebook',
    loginUrl: 'https://www.facebook.com/login',
    // c_user holds the signed-in account ID.
    isLoggedIn: async (ctx) => (await ctx.cookies('https://www.facebook.com')).some((c) => c.name === 'c_user' && !!c.value),
  },
  poshmark: {
    label: 'Poshmark',
    loginUrl: 'https://poshmark.com/login',
    // Poshmark sets a jwt/ui cookie once signed in and sends you to your feed.
    isLoggedIn: async (ctx, page) => {
      const cookies = await ctx.cookies('https://poshmark.com');
      if (cookies.some((c) => (c.name === 'jwt' || c.name === 'ui') && !!c.value)) return true;
      const pathname = page && !page.isClosed() ? new URL(page.url()).pathname : '';
      return pathname.startsWith('/feed');
    },
  },
};

export const isSite = (value: string): value is Profile => value in SITES;

export interface ConnectionStatus {
  site: Profile;
  label: string;
  connected: boolean;
  checkedAt: string | null;
  loginOpen: boolean;
  message: string | null;
}

// ---------- Persisted status ----------

type Saved = Partial<Record<Profile, { connected: boolean; checkedAt: string }>>;
const stateFile = path.join(config.dataDir, 'connections.json');

function readSaved(): Saved {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Saved;
  } catch {
    return {};
  }
}

export function setConnected(site: Profile, connected: boolean): void {
  const saved = readSaved();
  saved[site] = { connected, checkedAt: new Date().toISOString() };
  fs.writeFileSync(stateFile, JSON.stringify(saved, null, 2));
}

const loginPages = new Map<Profile, Page>();
const messages = new Map<Profile, string>();

export function connectionStatus(): ConnectionStatus[] {
  const saved = readSaved();
  return (Object.keys(SITES) as Profile[]).map((site) => ({
    site,
    label: SITES[site].label,
    connected: saved[site]?.connected ?? false,
    checkedAt: saved[site]?.checkedAt ?? null,
    loginOpen: loginPages.has(site),
    message: messages.get(site) ?? null,
  }));
}

// ---------- Login flow ----------

export async function startLogin(site: Profile): Promise<void> {
  if (config.headless) throw new HttpError(400, 'Logging in needs a visible browser. Set HEADLESS=false in .env');

  const existing = loginPages.get(site);
  if (existing && !existing.isClosed()) {
    await existing.bringToFront().catch(() => {});
    return;
  }

  messages.delete(site);
  const context = await getContext(site);
  // A fresh browser opens with a blank tab; use it instead of adding another.
  const page = context.pages().find((p) => p.url() === 'about:blank') ?? (await context.newPage());
  loginPages.set(site, page);
  await page.goto(SITES[site].loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.bringToFront().catch(() => {});
  void watchLogin(site, context, page);
}

async function watchLogin(site: Profile, context: BrowserContext, page: Page): Promise<void> {
  const deadline = Date.now() + 15 * 60_000;
  try {
    while (Date.now() < deadline) {
      if (page.isClosed()) {
        // Window closed by hand: check whether the login stuck before giving up.
        await new Promise((r) => setTimeout(r, 2000)); // let the browser finish shutting down
        const connected = await checkLogin(site);
        if (!connected) messages.set(site, 'The login window was closed before you finished logging in');
        return;
      }
      if (await SITES[site].isLoggedIn(context, page).catch(() => false)) {
        setConnected(site, true);
        await new Promise((r) => setTimeout(r, 1500)); // let the site finish setting cookies
        loginPages.delete(site);
        // Close the whole window unless a listing is being posted in it.
        if (context.pages().filter((p) => p !== page).length === 0) await context.close();
        else await page.close();
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    messages.set(site, 'Login timed out after 15 minutes');
    await page.close().catch(() => {});
  } catch (err) {
    messages.set(site, shortError(err));
  } finally {
    loginPages.delete(site);
  }
}

/** Verifies the saved session without showing a window. */
export async function checkLogin(site: Profile): Promise<boolean> {
  try {
    const connected = await withQuietContext(site, (ctx) => SITES[site].isLoggedIn(ctx));
    setConnected(site, connected);
    messages.delete(site);
    return connected;
  } catch (err) {
    messages.set(site, `Couldn't check the login: ${shortError(err)}`);
    return false;
  }
}

/** Signs out by deleting that site's browser profile. */
export async function logout(site: Profile): Promise<void> {
  await loginPages.get(site)?.close().catch(() => {});
  loginPages.delete(site);
  await closeContext(site);
  await fs.promises.rm(profileDir(site), { recursive: true, force: true });
  setConnected(site, false);
  messages.delete(site);
}
