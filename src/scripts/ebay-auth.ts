import readline from 'node:readline/promises';
import { config } from '../config';
import { consentUrl, exchangeCode, missingAppConfig } from '../platforms/ebay/client';

const missing = missingAppConfig();
if (missing.length) {
  console.error(`Set ${missing.join(', ')} in .env first (see README → eBay setup).`);
  process.exit(1);
}

console.log(`\neBay ${config.ebay.env} authorization\n`);
console.log('1. Open this URL and sign in with the eBay account you sell from');
if (config.ebay.env === 'sandbox') console.log('   (use a sandbox test user, not your real account):');
console.log(`\n   ${consentUrl()}\n`);
console.log('2. After you click "Agree", eBay redirects to your "auth accepted" URL.');
console.log('   Copy that whole URL from the address bar and paste it here.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question('Redirect URL: ')).trim();
rl.close();

const raw = answer.match(/[?&]code=([^&#]+)/)?.[1] ?? answer;
const code = decodeURIComponent(raw);
if (!code) {
  console.error('No authorization code found.');
  process.exit(1);
}

await exchangeCode(code);
console.log('\neBay connected. Next: npm run ebay:setup');
