# Crosslister

Enter an item once (photos, title, price, condition and so on), store it in SQLite, then post it to **eBay**, **Facebook Marketplace** and **Poshmark** from one small web UI.

| Platform | How it posts | Why |
| --- | --- | --- |
| eBay | Official Sell APIs (Inventory, Media, Taxonomy) | Stable, no account risk |
| Facebook Marketplace | Playwright drives the "Create listing" form | Meta's listing API is only for approved partners |
| Poshmark | Playwright drives poshmark.com/create-listing | No public listing API |

By default the browser platforms run in **review mode**: Crosslister fills in the form, leaves the tab open with a banner, and waits for you to click Publish. Set `POST_MODE=auto` to click Publish too. Even in auto mode, a listing falls back to review if any field couldn't be filled.

> **Run this on your own computer.** The browser automation opens real Chrome windows using your saved logins. Automating Facebook and Poshmark goes against their terms of service, and an account can be restricted for it. Review mode and the built-in pauses keep the activity close to normal use, but the risk is never zero.

## Setup

Requirements: **Node 22.13+** (uses the built-in `node:sqlite`) and **Google Chrome**. To use Playwright's own Chromium instead of Chrome, run `npx playwright install chromium` and set `BROWSER_CHANNEL=chromium`.

```bash
npm install
cp .env.example .env
```

### 1. Log in to Facebook and Poshmark (once)

```bash
npm run login -- facebook
npm run login -- poshmark
```

A browser window opens. Log in, finish any 2FA, then close the window. Each session is saved in `data/profiles/<site>` and reused for posting. Run the command again whenever a site logs you out.

### 2. Connect eBay

1. Create an account at [developer.ebay.com](https://developer.ebay.com) and open **Application Keys**. Create a **Sandbox** keyset first.
2. Under **User Tokens**, choose **Get a Token from eBay via Your Application** and add an eBay Redirect URL. Set its "auth accepted URL" to any page (for example `https://localhost/ebay-ok`). Copy the **RuName**.
3. Put `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` and `EBAY_RU_NAME` in `.env`, then:

```bash
npm run ebay:auth     # open the printed URL, agree, paste the redirect URL back
npm run ebay:setup    # opts into business policies, creates your ship-from location, prints policy IDs
```

4. Copy the policy IDs that `ebay:setup` prints into `.env`. Set `EBAY_LOCATION_POSTAL_CODE` before running it so it can create the ship-from location.
   - Sandbox accounts start with no policies. `npm run ebay:setup -- --create-policies` creates a basic set: free USPS Ground Advantage shipping, immediate payment, 30-day returns paid by the buyer.
   - On production, you'd normally use the shipping/payment/return policies you already have in Seller Hub.
5. Once a sandbox listing works, create a **Production** keyset, set `EBAY_ENV=production` with the production keys, and run `ebay:auth` and `ebay:setup` again. Tokens are stored separately for each environment.

### 3. Run it

```bash
npm start            # http://localhost:3000
```

## Using it

1. **+ New item**: add photos (the first one is the cover), title, price, condition, and so on.
2. **Save & post to all**, or post to one platform from its card.
3. Watch each platform's status: *Queued → Posting → Review in browser → Listed* (or *Failed* with the reason, plus a Retry button).
4. **Mark sold** ends the eBay listing through the API and flags Facebook and Poshmark as *Delist manually*. Click **Done** on those once you've removed them.

### Fields each platform uses

| Field | eBay | Facebook | Poshmark |
| --- | --- | --- | --- |
| Title (≤ 80 chars) | ✓ | ✓ | ✓ |
| Description | ✓ (converted to HTML) | ✓ | ✓ |
| Price | ✓ | whole dollars | whole dollars |
| Original price | | | ✓ (defaults to price) |
| Condition | New / Used + note | New / Used grades | NWT / Like New / Good / Fair |
| Brand, size, color | item specifics | size/brand if shown | ✓ |
| Category | **eBay category ID**, or blank to auto-suggest from the title | **Facebook category** (suggestions included) | **Poshmark category** as `Women > Tops > Blouses` |
| eBay item specifics | `Name: value` lines, `a \| b` for multiple values | | |
| Weight (oz) | package weight | | |

eBay checks the category's **required item specifics** before posting. If any are missing, the listing fails with a message such as `requires these item specifics: Department`. Add a line like `Department: Women` to the item and retry.

Re-posting to eBay updates the existing listing in place, since it's keyed by SKU. Re-posting to Facebook or Poshmark would create a duplicate, so the UI hides that button once an item is listed there.

## When Facebook or Poshmark changes their site

Expect this to happen regularly. All selectors live at the top of `src/platforms/facebook.ts` and `src/platforms/poshmark.ts`. Each field has fallbacks, and a field that can't be found turns into a warning (shown in the UI and on the in-page banner) instead of failing the listing, so you can finish that field by hand. When a field keeps failing, open the page, inspect the input, and update its locator. Selectors assume the sites are in English.

## Project layout

```
src/
  server.ts              HTTP API + static UI (no framework)
  db.ts                  SQLite schema and queries (data/crosslister.db)
  jobs.ts                one posting queue per platform
  validate.ts            item form validation
  platforms/
    ebay/client.ts       OAuth (refresh + app tokens) and request helper
    ebay/index.ts        images → category → item specifics → inventory item → offer → publish
    facebook.ts          Marketplace form automation
    poshmark.ts          Poshmark form automation
    browser.ts           persistent Chrome profiles, review/auto hand-off
  scripts/               login, ebay:auth, ebay:setup
public/                  the web UI
data/                    database, photos, browser profiles, eBay tokens (git-ignored)
```

`npm run typecheck` runs the TypeScript 7 native compiler.

## Not built yet

- Automatic delisting on Facebook/Poshmark when an item sells elsewhere (eBay is automatic).
- Detecting sales: eBay can send order notifications; the browser sites would need polling.
- CSV bulk import.
