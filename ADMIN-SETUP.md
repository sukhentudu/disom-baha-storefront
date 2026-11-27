# Disom Baha admin panel: setup

The admin panel lives at **`/admin/`** on your website:
<https://www.disombaha.com/admin/>. It uses a free [Supabase](https://supabase.com)
project for logins and data. The website itself stays on GitHub Pages.

| Section | What you can do |
|---|---|
| Dashboard | New orders, orders to ship, this month's sales, low stock, unanswered messages |
| Orders | Every checkout request from the website. Change status, add tracking and private notes, WhatsApp or call the customer, export CSV |
| Products | Add, edit, hide or delete plants. Upload photos, set price, sizes, pot colours and stock |
| Customers | Everyone who has ordered, grouped by phone, with order count and spend. Export CSV |
| Messages | Messages from the website's contact form. Reply by WhatsApp or email |
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

7. Open **Authentication → URL Configuration**. Set **Site URL** to `https://www.disombaha.com` and add `https://www.disombaha.com/admin/` under **Redirect URLs**, so password-reset emails come back to the admin panel.

## 2. Publish and sign in

1. Commit and push to `main`. GitHub Actions publishes the site.
2. Open <https://www.disombaha.com/admin/> and sign in.
3. Go to **Products → Import demo catalog** to copy the current four plants into the database, then edit them with your real photos, prices and stock. Untick **Demo content** on each one when it's real.

Until `site-config.js` has the Supabase details, the website keeps working exactly as before, using the demo catalog in `catalog.js`.

## 3. Connect disombaha.com

The GoDaddy DNS records below are already in place for `disombaha.com`. To finish:

1. In GitHub: **Settings → Pages → Custom domain**, enter `www.disombaha.com` and click **Save**.
2. Keep these GoDaddy DNS records (**My Products → disombaha.com → DNS**). If you ever need to set them up again, delete any other `A` record for `@` and `CNAME` for `www` first:

   | Type | Name | Value |
   |---|---|---|
   | CNAME | www | `sukhentudu.github.io` |
   | A | @ | `185.199.108.153` |
   | A | @ | `185.199.109.153` |
   | A | @ | `185.199.110.153` |
   | A | @ | `185.199.111.153` |

3. Wait until GitHub shows "DNS check successful" and the HTTPS certificate is ready (minutes to a day), then tick **Enforce HTTPS**. `disombaha.com` and the old `github.io` address will then forward to `https://www.disombaha.com/`.
4. Optional but recommended: verify the domain in your GitHub account (**profile picture → Settings → Pages → Add a domain**) so nobody else can use it on GitHub Pages.
5. Keep **Auto-renew** on for the domain in GoDaddy so it doesn't expire.

## 4. Uptime alerts

`.github/workflows/uptime.yml` runs every hour. It checks that the website loads, that the SSL certificate has at least 14 days left, and that Supabase answers. If anything fails, GitHub emails you; you can choose where these emails go under GitHub **Settings → Notifications → Actions**.

- It checks `https://www.disombaha.com/`. To check another address, add a repository variable named `SITE_URL` under **Settings → Secrets and variables → Actions → Variables**.
- The hourly database check also keeps the free Supabase project from pausing after 7 quiet days.
- GitHub pauses scheduled checks in repositories with no commits for 60 days. If that happens, re-enable the workflow under **Actions**.

## 5. Search engines

1. In the admin panel, open **SEO**, write a title and description for each page, and click **Run SEO check**.
2. Click **Build sitemap.xml**, download it, and add it to the root of this repository.
3. Add `www.disombaha.com` in [Google Search Console](https://search.google.com/search-console) and submit `https://www.disombaha.com/sitemap.xml`.

## Adding another admin

1. Supabase → **Authentication → Users → Add user** (tick Auto Confirm).
2. Admin panel → **Team** → enter their email → **Add admin**.

## About customer data

Orders and contact messages now live in your Supabase database instead of the Google Sheet's Orders tab. They include names, phone numbers and addresses. Keep admin passwords strong and only add people you trust as admins. You can export orders and customers to CSV from the admin panel at any time.
