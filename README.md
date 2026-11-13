# Disom Baha storefront

Static storefront for Disom Baha. It uses HTML, CSS, and JavaScript and is set up to deploy to GitHub Pages with GitHub Actions.

## Publish with GitHub Pages

1. Create a GitHub repository named `disom-baha-storefront` and add this project to its `main` branch.
2. Open the repository's **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**.
3. Open **Actions**. The “Deploy Disom Baha to GitHub Pages” workflow publishes the site after code is pushed to `main`.
4. When the workflow completes, GitHub shows the public site link in the Pages settings and in the workflow's `github-pages` environment.

This repository contains a static demo catalog. The catalog admin at `/admin.html` only saves in the current browser; it is not a secure or shared production admin. Orders and payments are coordinated through the WhatsApp concierge.

## Notes

- For GitHub Free, GitHub Pages requires a public repository. The published website is public, and a public repository also makes its source files and demo assets visible. GitHub Pro and some organization plans also support Pages from private repositories.
- Do not commit customer data, payment details, passwords, API keys, or private business notes.
- The site uses relative paths and works as a GitHub Pages project site under `/<repository-name>/`.
- To update the site, push changes to `main`; GitHub Actions deploys them automatically.
- The catalog's Google Sheets CSV source is optional and currently not configured.
