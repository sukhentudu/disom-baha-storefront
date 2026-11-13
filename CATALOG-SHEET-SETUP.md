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

## Admin access

Use the private Google Sheet ‘Disom Baha — Products & Operations’ for product records, orders, settings, and care guides. Keep the workbook private because its Orders tab can contain customer details.

Google Advanced Protection blocked the custom sidebar, so use the workbook tabs directly. The public website no longer includes an admin page.
