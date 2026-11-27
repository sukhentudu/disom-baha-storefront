# Disom Baha storefront

Static storefront for Disom Baha. It uses HTML, CSS, and JavaScript and is set up to deploy to GitHub Pages with GitHub Actions.

## Publish with GitHub Pages

1. Create a GitHub repository named `disom-baha-storefront` and add this project to its `main` branch.
2. Open the repository's **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**.
3. Open **Actions**. The “Deploy Disom Baha to GitHub Pages” workflow publishes the site after code is pushed to `main`.
4. When the workflow completes, GitHub shows the public site link in the Pages settings and in the workflow's `github-pages` environment.

Orders and payments are coordinated through the WhatsApp concierge, and order requests are confirmed only after concierge approval.

## Admin panel

The site includes an admin panel at `/admin/` for orders, products, customers, contact messages, page content, SEO, analytics and uptime. Customers can pay online with Razorpay and track orders at `/track.html`; payments and emails run in the Supabase server function `supabase/functions/shop/`. It is backed by a Supabase database whose security rules live in `supabase/schema.sql`. See **[ADMIN-SETUP.md](ADMIN-SETUP.md)** for the one-time setup and for connecting the GoDaddy domain.

Until `site-config.js` contains the Supabase details, the storefront uses the demo catalog in `catalog.js` and the admin panel shows setup instructions.

## Notes

- For GitHub Free, GitHub Pages requires a public repository. The published website is public, and a public repository also makes its source files and demo assets visible. GitHub Pro and some organization plans also support Pages from private repositories.
- Do not commit customer data, payment details, passwords, or private business notes. The Supabase anon/publishable key in `site-config.js` is meant to be public; never commit the `service_role` or secret key.
- The site uses relative paths and works as a GitHub Pages project site under `/<repository-name>/`.
- To update the site, push changes to `main`; GitHub Actions deploys them automatically.
- The catalog's Google Sheets CSV source is optional and currently not configured.
