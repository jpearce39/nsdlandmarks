# nsdlandmarks
A search tool for landmarks to the north, east, south and west of a property

The page uses a Cloudflare Worker endpoint at `/api/overpass` to query OpenStreetMap without browser CORS restrictions. Deploy with the included `wrangler.jsonc` configuration so the Worker and static assets are published together. From an authenticated Wrangler environment, run `npx wrangler deploy`; a Cloudflare Git deployment should also use this Wrangler configuration.

Serving `index.html` as a plain static file (including with `python3 -m http.server`) does not provide the Overpass proxy. Use the deployed Cloudflare Worker for searches.
