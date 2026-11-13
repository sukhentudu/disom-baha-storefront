# Disom Baha catalog sheet

The storefront currently uses the demo products in `catalog.js`. Once you have a Google Sheet, the site can read its **published CSV** as the product source.

## Sheet columns

Create a header row with these column names, then add one product per row:

`id, name, botanical, price, image, tag, isDemo, light, lightFilter, water, waterFilter, humidity, sizeOptions, height, potDiameter, includes, stock, categories, description, review, reviewBy`

- `id`: short unique key, such as `snake`.
- `image`: public image URL or a site asset path.
- `lightFilter`: `low`, `medium`, or `bright`.
- `waterFilter`: `infrequent`, `medium`, or `frequent`.
- `sizeOptions`: separate options with `|`; write each as `label:extra`, for example `4 inch nursery plant:0|6 inch fuller plant:250`.
- `categories`: separate tags with `|`, such as `indoor|low-maintenance`.
- `stock`: available quantity, or leave blank to confirm availability in WhatsApp.
- `isDemo`: `true` while sample content is in use; `false` for verified product content.
- `review` and `reviewBy`: use only a genuine review with permission; leave blank when there are none.

## Connect the sheet

1. Put only customer-facing catalog information in the sheet. Do not include customer details or internal notes.
2. Publish the sheet as CSV using Google Sheets’ **Publish to web** option.
3. Copy its published CSV URL into `window.DISOM_BAHA_SHEET_CSV_URL` near the top of `catalog.js`.
4. Serve the site over HTTPS so the browser can fetch the published sheet. The site keeps the demo catalog as a fallback if the sheet is unavailable.

## Use the temporary catalog admin

Open `admin.html` to edit the sample products, stock, images, and care details. This demo saves changes only in the current browser on the current device. It has no sign-in and does not update a Google Sheet or shared inventory. If a published sheet URL is configured, the sheet remains the storefront source of truth.

Use **Download CSV for Sheets** in the admin page to export the current catalog, then import that file into a Google Sheet. Keep customer addresses, phone numbers, payment details, and internal notes out of the catalog sheet.

The demo admin is not a production security boundary. A real multi-device admin needs protected sign-in and a shared data source or a server-side integration.
