import { getContext, type Profile } from '../platforms/browser';

const LOGIN_URLS: Record<Profile, string> = {
  facebook: 'https://www.facebook.com/login',
  poshmark: 'https://poshmark.com/login',
};

const site = process.argv[2] as Profile | undefined;
if (!site || !(site in LOGIN_URLS)) {
  console.error('Usage: npm run login -- facebook   (or poshmark)');
  process.exit(1);
}

const context = await getContext(site);
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(LOGIN_URLS[site]);

console.log(`Log in to ${site} in the browser window (finish any 2FA), then close the window.`);
console.log(`The session is saved to data/profiles/${site} and reused when posting.`);
await new Promise<void>((resolve) => context.on('close', () => resolve()));
console.log('Saved.');
