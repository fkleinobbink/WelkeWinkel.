# WelkeWinkel – scraper

Bouwt de database achter welkewinkel.nl: welke producten je bij welke fysieke winkel kunt kopen, plus alle filialen.
Alles draait in GitHub Actions, er is geen eigen server of computer nodig.

## Database downloaden
Releases → **data** → `scraper.db.gz` (SQLite). Wordt na elke volledige run opnieuw gebouwd.
De actuele aantallen per winkel staan in de branch `status` (`STATUS.md`).

Tabellen (compatibel met de oude site):
- `sites`: winkelketens (`name` = id, `display_name`, `product_count`, `store_count`)
- `products`: site, name, brand, amount, price, gtin, sku, category, product_url, image_url, `store_id` (alleen bij unieke items, bv. RataPlan)
- `store_locations`: filialen (OpenStreetMap, of de eigen lijst van de winkel)
- `stock`: voorraad per filiaal (product_id, store_id, status, quantity)

## Runnen vanaf je telefoon
Actions → **crawl** → *Run workflow*:
- `shops`: bijv. `ikea,gamma` (leeg = alle winkels met een config)
- `max`: bijv. `60` voor een korte test (schrijft `test-*` bestanden, raakt de echte data niet)

Elke nacht draait automatisch een run voor alle winkels met `"daily": true` in hun config.

## Hoe het werkt
- `config/shops.json`: lijst van de ~100 meest bezochte ketens (+ OSM-merknamen voor de filialen)
- `config/shops/<id>.json`: hoe een winkel gecrawld wordt
  - `strategy: "sitemap"`: product-URL's uit de sitemap, productdata uit de pagina (schema.org JSON-LD)
  - `strategy: "listing"`: overzichtspagina's aflopen (`listing.pages` met `{offset}`)
  - `strategy: "adapter"`: eigen code in `src/adapters/<naam>.mjs` (API's van AH, Kruidvat, PLUS, WooCommerce…)
  - `parser`: eigen uitleesfunctie in `src/parsers/<naam>.mjs` (bv. ALDI, Dirk)
  - `engine`: `fetch` (standaard), `impersonate` (browser-TLS via curl_cffi) of `browser` (echte Chromium)
- Incrementeel: pagina's die recent zijn opgehaald worden hergebruikt (`reuseDays`, standaard 7)

## Nieuwe winkel toevoegen
1. Zet hem in `config/shops.json`
2. Maak `config/shops/<id>.json` (kijk naar een vergelijkbare winkel)
3. Testrun met `max: 60` en kijk naar de "Testcontrole" in de run
4. Lukt het, dan volledige run en `"daily": true`

Handige tools: `src/discover.mjs` (stelt automatisch een config voor), `tools/netlog.mjs` (logt de API-verzoeken van een site in Chromium).
