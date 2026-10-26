# Item Lister

Enter an item once (photos, title, price, condition and so on), store it in SQLite, then post it to **eBay**, **Facebook Marketplace** and **Poshmark** from a React + Mantine web UI. All logins are done from the UI.

| Platform | How it posts | How you log in |
| --- | --- | --- |
| eBay | Official Sell APIs (Inventory, Media, Taxonomy) | **Connections → Open eBay sign-in**, then paste the page eBay returns you to |
| Facebook Marketplace | Playwright drives the "Create listing" form | **Connections → Log in to Facebook** opens a browser window |
| Poshmark | Playwright drives poshmark.com/create-listing | **Connections → Log in to Poshmark** opens a browser window |

By default the browser platforms run in **review mode**: Item Lister fills in the form, leaves the tab open with a banner, and waits for you to click Publish. Set `POST_MODE=auto` to click Publish too. Even in auto mode, a listing falls back to review if any field couldn't be filled.

> **Run this on your own computer.** Logging in and posting open real Chrome windows that keep your Facebook and Poshmark sessions. Automating those sites goes against their terms of service, and an account can be restricted for it. Review mode and the built-in pauses keep the activity close to normal use, but the risk is never zero.

## Setup

Requirements: **Node 22.13+** (uses the built-in `node:sqlite`) and **Google Chrome**. To use Playwright's own Chromium instead of Chrome, run `npx playwright install chromium` and set `BROWSER_CHANNEL=chromium`.

```bash
npm install
cp .env.example .env
npm start            # builds the UI, then serves everything at http://localhost:3000
```

While working on the code, run `npm run dev` instead. The UI then runs on http://localhost:5173 with hot reload, and the API on :3000.

### Connect your accounts

Open **Connections** in the header (the badge shows how many of the 3 are ready).

**Facebook and Poshmark:** click **Log in**. A browser window opens on the site's login page. Log in there, including any 2-step code. Item Lister notices you're signed in (by watching the session cookies), saves the session to `data/profiles/<site>`, and closes the window. **Check** re-verifies a saved login without opening a window. **Log out** deletes that saved browser profile. If a site logs you out later, the next post fails with "Not logged in" and the card flips back to **Log in**.

**eBay:**

1. Create an account at [developer.ebay.com](https://developer.ebay.com) and open **Application Keys**. Create a **Sandbox** keyset first.
2. Under **User Tokens**, choose **Get a Token from eBay via Your Application** and add an eBay Redirect URL. Copy its **RuName**.
3. Put `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` and `EBAY_RU_NAME` in `.env` and restart. These are the only settings that live in `.env`.
4. In **Connections → eBay**, click **Open eBay sign-in**, sign in (with a sandbox test user while `EBAY_ENV=sandbox`) and click **Agree**. Paste the address of the page eBay sends you to, then click **Connect**.
   - To skip pasting, set the redirect's "auth accepted URL" to `http://localhost:3000/api/ebay/callback`, if eBay accepts a localhost address for your keyset. You'll then land straight back in the app.
5. Choose your **shipping, payment and return policies**. Sandbox accounts start with none, so use **Create starter policies**: free USPS Ground Advantage shipping, immediate payment, and 30-day returns paid by the buyer. Then enter the **ZIP code** you ship from.
6. Once a sandbox listing works, create a **Production** keyset, set `EBAY_ENV=production` with the production keys, restart, and connect again. Tokens and policy choices are stored separately for each environment.

## Using it

1. **New item**: drop in photos (the first is the cover; ★ makes another photo the cover), then fill in the title, price, condition and so on.
2. **Save & post to all**, or post to one platform from its box on the item card.
3. Each platform shows its status: *Queued → Posting → Review in browser → Listed*, or *Failed* with the reason and a Retry button.
4. **⋯ → Mark sold** ends the eBay listing through the API and flags Facebook and Poshmark as *Delist manually*. Click **Done** once you've removed them.

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

Expect this to happen regularly. All form selectors live at the top of `src/platforms/facebook.ts` and `src/platforms/poshmark.ts`, and the login detection lives in `src/connections.ts`. Each field has fallbacks, and a field that can't be found turns into a warning (shown in the UI and on the in-page banner) instead of failing the listing, so you can finish that field by hand. Selectors assume the sites are in English.

## Project layout

```
src/                     API server (Node, no framework)
  server.ts              routes + serves the built UI from dist/web
  connections.ts         Facebook/Poshmark login windows, session checks, logout
  db.ts                  SQLite schema and queries (data/item-lister.db)
  jobs.ts                one posting queue per platform
  platforms/
    ebay/client.ts       OAuth, stored policy choices, request helper
    ebay/setup.ts        business policies + ship-from location
    ebay/index.ts        images → category → item specifics → inventory item → offer → publish
    facebook.ts          Marketplace form automation
    poshmark.ts          Poshmark form automation
    browser.ts           persistent Chrome profiles, review/auto hand-off
web/                     React + Mantine UI (Vite)
  src/App.tsx            shell, item list, polling
  src/components/        ItemCard, ItemEditor, ConnectionsDrawer
data/                    database, photos, browser profiles, eBay tokens (git-ignored)
```

`npm run typecheck` checks both the server and the UI with the TypeScript 7 native compiler.

## Not built yet

- Automatic delisting on Facebook/Poshmark when an item sells elsewhere (eBay is automatic).
- Detecting sales: eBay can send order notifications; the browser sites would need polling.
- CSV bulk import.
