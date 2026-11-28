# Disom Baha admin panel: setup

The admin panel lives at **`/admin/`** on your website:
<https://disombaha.com/admin/>. It uses a free [Supabase](https://supabase.com)
project for logins and data. The website itself stays on GitHub Pages.

| Section | What you can do |
|---|---|
| Dashboard | New orders, orders to ship, this month's sales, low stock, unanswered messages |
| Orders | Every checkout request from the website. Change status, add tracking and private notes, WhatsApp or call the customer, export CSV |
| Products | Add, edit, hide or delete plants. Upload photos, set price, sizes, pot colours and stock |
| Customers | Everyone who has ordered, grouped by phone, with order count and spend. Export CSV |
| Messages | Messages from the website's contact form. Reply by WhatsApp or email |
| Chat | Live conversations with customers who sign in with Google; replies are also emailed |
| Reviews | Approve, hide or delete reviews from customers whose order has shipped |
| Content | Announcement bar text, catalog note, and plant care journal guides |
| SEO | Search titles and descriptions for each page, a site check for broken links and images, and a sitemap |
| Analytics | Daily page views, top pages, top plants, where visitors come from |
| Uptime | Live check of the website and database, plus GitHub's hourly checks |
| Team | Add or remove admins, change your password |

## How it stays secure

- Signing in uses Supabase accounts. Only accounts listed as admins can see or change anything.
- The rules are enforced by the database (`supabase/schema.sql`), not by the web page. Someone who reads the public code still can't read orders or change prices.
- Visitors can only read live products, published guides and page text. Their only writes are placing an order request, sending a contact message and counting a page view, and the database checks each one.
- Order prices are recalculated by the database from the product list, so a customer can't change what they pay by editing the page.
- `site-config.js` contains the **anon/publishable** key. That key is designed to be public. **Never** put the `service_role` / secret key in this repository.

## 1. Create the Supabase project (about 10 minutes)

1. Sign up at <https://supabase.com> and click **New project**. Choose the **Mumbai (ap-south-1)** region and save the database password somewhere safe.
2. Open **SQL Editor → New query**. Paste the whole of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**. You should see "Success. No rows returned".
3. Open **Authentication → Sign In / Providers** (on some dashboards: Authentication → Settings) and turn **off** "Allow new users to sign up". Only you will create accounts.
4. Open **Authentication → Users → Add user → Create new user**. Enter your email and a strong password, and tick **Auto Confirm User**.
5. Back in **SQL Editor**, run this with your email to make yourself the first admin:

   ```sql
   insert into public.admin_users (user_id, email)
   select id, email from auth.users where email = 'you@example.com';
   ```

6. Open **Project Settings → API Keys**. Copy the **Project URL** and the **anon public** (or **publishable**) key into `site-config.js`:

   ```js
   supabaseUrl: "https://abcdefgh.supabase.co",
   supabaseAnonKey: "eyJ…",
   ```

7. Open **Authentication → URL Configuration**. Set **Site URL** to `https://disombaha.com` and add `https://disombaha.com/admin/` under **Redirect URLs**, so password-reset emails come back to the admin panel.

## 2. Publish and sign in

1. Commit and push to `main`. GitHub Actions publishes the site.
2. Open <https://disombaha.com/admin/> and sign in.
3. Go to **Products → Import demo catalog** to copy the current four plants into the database, then edit them with your real photos, prices and stock. Untick **Demo content** on each one when it's real.

Until `site-config.js` has the Supabase details, the website keeps working exactly as before, using the demo catalog in `catalog.js`.

## 3. Connect disombaha.com

The GoDaddy DNS records below are already in place for `disombaha.com`. To finish:

1. In GitHub: **Settings → Pages → Custom domain** is set to `disombaha.com` (done). After changing the custom domain, publish once more (push to `main`, or **Actions → Deploy Disom Baha to GitHub Pages → Run workflow**) so GitHub serves the site on it.
2. Keep these GoDaddy DNS records (**My Products → disombaha.com → DNS**). If you ever need to set them up again, delete any other `A` record for `@` and `CNAME` for `www` first:

   | Type | Name | Value |
   |---|---|---|
   | CNAME | www | `sukhentudu.github.io` |
   | A | @ | `185.199.108.153` |
   | A | @ | `185.199.109.153` |
   | A | @ | `185.199.110.153` |
   | A | @ | `185.199.111.153` |

3. Wait until GitHub shows "DNS check successful" and the HTTPS certificate is ready (minutes to a day), then tick **Enforce HTTPS**. `www.disombaha.com` and the old `github.io` address forward to `https://disombaha.com/`.
4. Optional but recommended: verify the domain in your GitHub account (**profile picture → Settings → Pages → Add a domain**) so nobody else can use it on GitHub Pages.
5. Keep **Auto-renew** on for the domain in GoDaddy so it doesn't expire.

## 4. Uptime alerts

`.github/workflows/uptime.yml` runs every hour. It checks that the website loads, that the SSL certificate has at least 14 days left, and that Supabase answers. If anything fails, GitHub emails you; you can choose where these emails go under GitHub **Settings → Notifications → Actions**.

- It checks `https://disombaha.com/`. To check another address, add a repository variable named `SITE_URL` under **Settings → Secrets and variables → Actions → Variables**.
- The hourly database check also keeps the free Supabase project from pausing after 7 quiet days.
- GitHub pauses scheduled checks in repositories with no commits for 60 days. If that happens, re-enable the workflow under **Actions**.

## 5. Search engines

1. In the admin panel, open **SEO**, write a title and description for each page, and click **Run SEO check**.
2. Click **Build sitemap.xml**, download it, and add it to the root of this repository.
3. Add `disombaha.com` in [Google Search Console](https://search.google.com/search-console) and submit `https://disombaha.com/sitemap.xml`.

## 6. Online payments, order emails and tracking

Customers can pay online with Razorpay (UPI, cards, netbanking, wallets) instead of sending an order request on WhatsApp. Paid orders show up in the admin panel as **Paid online** with stock already taken off. You get an email for every paid order, and the customer gets a receipt with a link to the order tracking page (`track.html`). The WhatsApp buttons stay on the site for questions.

The payment logic runs in the Supabase server function `shop` (`supabase/functions/shop/`). It works out every amount from the database, checks Razorpay's signatures, and marks orders paid. Secret keys live only in Supabase, never in this repository.

### 6.1 Gmail app password (for order and message emails)

1. Turn on **2-Step Verification** for the Gmail account: Google Account → Security.
2. Open **Google Account → Security → App passwords**, create one named "Disom Baha shop", and copy the 16-character password.

### 6.2 Razorpay test keys

1. Sign up at <https://razorpay.com> and stay in **Test mode** (toggle at the top of the dashboard).
2. Open **Account & Settings → API Keys → Generate Test Key**. Copy the **Key ID** (`rzp_test_…`) and the **Key Secret**.
3. Open **Account & Settings → Webhooks → Add New Webhook**:
   - Webhook URL: `https://prpnlxxplddmarxnugsw.supabase.co/functions/v1/shop/razorpay-webhook`
   - Secret: make up a long random password and keep it for the next step
   - Active events: `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`

### 6.3 Add the secrets in Supabase

Supabase → project **disom-baha** → **Edge Functions → Secrets** (or **Project Settings → Edge Functions**), then add:

| Name | Value |
|---|---|
| `RAZORPAY_KEY_ID` | Key ID from 6.2 |
| `RAZORPAY_KEY_SECRET` | Key Secret from 6.2 |
| `RAZORPAY_WEBHOOK_SECRET` | the webhook secret you made up in 6.2 |
| `GMAIL_USER` | your Gmail address |
| `GMAIL_APP_PASSWORD` | the app password from 6.1 |
| `OWNER_EMAIL` | optional: where new-order emails go (defaults to `GMAIL_USER`) |

Never paste these into chat, code or GitHub.

### 6.4 Test, then switch on

1. Admin panel → **Content → How customers order** → **Pay online with Razorpay** → **Save site text**.
2. Place an order on the website. In test mode, pay with UPI ID `success@razorpay`, or a test card from Razorpay's docs ("Test card details").
3. Check that the order shows as **Paid online** in the admin panel, that both emails arrived, and that `track.html` finds the order with its number and phone.
4. Update the announcement bar text under **Content**, since it still mentions WhatsApp ordering.

To pause online payments at any time, switch **How customers order** back to WhatsApp.

### 6.5 Going live with real payments

1. In Razorpay, complete **account activation (KYC)**: business details, PAN and bank account. Razorpay reviews your website, which needs clear **Terms & Conditions, Privacy Policy, Refund & Cancellation, Shipping & Delivery** and **Contact Us** pages with real business details. The current `policies.html` is marked as a demo.
2. After approval, switch Razorpay to **Live mode**. Generate live keys, set up the webhook again in live mode, and replace `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` in Supabase with the live values.

### Refunds

Refund from the Razorpay dashboard. The admin panel's **Open in Razorpay** link on each paid order goes straight there. When a full refund goes through, the order switches to **Refunded/Cancelled** automatically and its stock is put back.

## 7. Customer chat with Google sign-in

The chat box (`chat.js`) adds a **Chat** button to every page. Customers sign in with their Google account, then chat with you. You answer in the admin panel under **Chat**: replies appear instantly in their chat box and are emailed to them from your Gmail. You get an email when a customer writes, at most one per conversation until you reply. Each customer can only ever see their own conversation, and you can close, block or delete a conversation.

The chat box stays hidden until you switch it on (step 7.4).

### 7.1 Create a Google sign-in client (Google Cloud, about 10 minutes)

1. Open <https://console.cloud.google.com/> with your Google account and create a project named **Disom Baha**.
2. Go to **APIs & Services → OAuth consent screen** (shown as **Google Auth Platform**) and set it up:
   - App name: **Disom Baha**, with your support email
   - Audience: **External**
   - Authorized domains: `disombaha.com` and `prpnlxxplddmarxnugsw.supabase.co`
   - Data access / scopes: keep the basic `email`, `profile` and `openid` only
   - **Publish the app** (Audience → Publish app) so every Google user can sign in, not only test users
3. Go to **Clients → Create client → Web application**:
   - Authorized JavaScript origins: `https://disombaha.com`
   - Authorized redirect URIs: `https://prpnlxxplddmarxnugsw.supabase.co/auth/v1/callback`
   - Copy the **Client ID** and **Client secret**

### 7.2 Turn on Google in Supabase

1. Supabase → project **disom-baha** → **Authentication → Sign In / Providers → Google**. Switch it on, paste the Client ID and Client secret, and save.
2. On the same page, switch **Allow new users to sign up** back **on**. Each customer's first Google sign-in creates their account. These accounts can only see their own chat: the admin panel only opens for emails on your admin list (Team).
3. **Authentication → URL Configuration → Redirect URLs**: add `https://disombaha.com/**` so customers return to the page they were on.

### 7.3 Gmail

Chat emails use the same Gmail app password as order emails (section 6.1, secrets `GMAIL_USER` and `GMAIL_APP_PASSWORD`). Without it, chat still works but no emails are sent.

### 7.4 Switch it on and test

1. Admin panel → **Content → Chat box on the website → On → Save site text**.
2. In a private browser window, open the website, click **Chat**, click **Continue with Google**, and send a message.
3. It appears in the admin panel under **Chat** (a red count shows unread conversations). Reply there; the reply shows in the customer's chat box and is emailed to them.

To hide the chat again, switch **Chat box on the website** to **Off**.

## 8. Stock holds, status emails and reviews

These run on their own once `supabase/schema.sql` has been run. On a database
set up before November 2026, run
[`supabase/upgrade-2026-11-stock-reviews.sql`](supabase/upgrade-2026-11-stock-reviews.sql)
once in the SQL Editor instead (it is safe to run again).

**Stock holds (no overselling).** Stock comes off the moment an order is placed,
so two people can never both buy the last plant. If nobody pays or confirms the
order in time (30 minutes for online payment, 24 hours for a WhatsApp order), a
job that runs every 5 minutes puts the stock back and adds a note to the order.
The stock number you see on a product is always what is still available to buy.
Confirming an order whose hold ran out takes the stock off again, or tells you
if it has sold out in the meantime.

**Status emails.** When you change an order to **Confirmed**, **Shipped**,
**Delivered** or **Cancelled**, the customer gets an email about a minute later
(only if they gave an email address). Add the courier tracking number when you
mark it Shipped and it is included. The delivered email invites them to review
their plants. Emails use the same Gmail settings as section 6.1; until those are
set, the emails wait and are retried, then given up after three tries.

**Reviews.** On the tracking page, a customer whose order has shipped can rate
and review each plant in it. New reviews wait in **Reviews** until you approve
them; approved reviews and the average rating show on the product page and
replace the sample review.

**Search.** The database also has a typo-tolerant product search
(`search_products`). The storefront doesn't need it while the catalog is small;
it is ready for when there are a few hundred plants.

## Adding another admin

1. Supabase → **Authentication → Users → Add user** (tick Auto Confirm).
2. Admin panel → **Team** → enter their email → **Add admin**.

## About customer data

Orders and contact messages now live in your Supabase database instead of the Google Sheet's Orders tab. They include names, phone numbers and addresses. Keep admin passwords strong and only add people you trust as admins. You can export orders and customers to CSV from the admin panel at any time.
