const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
const ALLOWED_TAGS = {
  amenity: ['school', 'place_of_worship'],
  railway: ['station'],
  shop: ['mall', 'supermarket', 'department_store'],
  leisure: ['park']
};

function isAllowedQuery(query) {
  const prefix = '[out:json][timeout:25];(';
  const suffix = ');out center tags;';
  if (!query.startsWith(prefix) || !query.endsWith(suffix)) return false;

  const clausesText = query.slice(prefix.length, -suffix.length);
  const clauses = [...clausesText.matchAll(
    /(node|way)\["(amenity|railway|shop|leisure)"="([a-z_]+)"\]\(around:(\d+),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\);/g
  )];
  if (!clauses.length || clauses.map(match => match[0]).join('') !== clausesText) return false;

  return clauses.every(([, , key, value, radius, lat, lon]) =>
    ALLOWED_TAGS[key].includes(value) &&
    Number(radius) <= 20000 &&
    Math.abs(Number(lat)) <= 90 &&
    Math.abs(Number(lon)) <= 180
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/overpass') return env.ASSETS.fetch(request);
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    }

    const body = await request.text();
    if (body.length > 100000) {
      return Response.json({ error: 'Query is too large.' }, { status: 413 });
    }

    const query = new URLSearchParams(body).get('data');
    if (!query) return Response.json({ error: 'Missing Overpass query.' }, { status: 400 });
    if (!isAllowedQuery(query)) {
      return Response.json({ error: 'Invalid Overpass query.' }, { status: 400 });
    }

    let lastError;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
            },
            body: new URLSearchParams({ data: query }),
            signal: AbortSignal.timeout(20000)
          });
          if (!response.ok) {
            lastError = `${new URL(endpoint).hostname} returned status ${response.status}`;
            if (response.status !== 429 || attempt > 0) break;

            const retryAfter = response.headers.get('Retry-After');
            const retryAfterSeconds = Number(retryAfter);
            const retryDelayMs = retryAfter == null
              ? 1000
              : Number.isFinite(retryAfterSeconds)
                ? retryAfterSeconds * 1000
                : Date.parse(retryAfter) - Date.now();
            if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 1000) break;

            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            continue;
          }
          return new Response(response.body, {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
          });
        } catch (error) {
          lastError = error instanceof Error ? error.message : 'Upstream request failed';
          break;
        }
      }
    }

    return Response.json(
      { error: `${lastError || 'All Overpass mirrors failed'}. Please try again in a moment.` },
      { status: 502 }
    );
  }
};