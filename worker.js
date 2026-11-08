const OVERPASS_ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
const MIRROR_DELAY_MS = 2000;
const DEFAULT_RETRY_DELAY_MS = 5000;
const MIN_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const ALLOWED_TAGS = {
  amenity: ['school', 'place_of_worship'],
  railway: ['station'],
  shop: ['mall', 'supermarket', 'department_store'],
  leisure: ['park']
};

function getRetryDelay(response) {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter == null) return DEFAULT_RETRY_DELAY_MS;

  const value = retryAfter.trim();
  const seconds = Number(value);
  const delayMs = value && Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(delayMs)) return DEFAULT_RETRY_DELAY_MS;
  if (delayMs > MAX_RETRY_DELAY_MS) return null;
  return Math.max(delayMs, MIN_RETRY_DELAY_MS);
}

function isAllowedQuery(query) {
  const prefix = '[out:json][timeout:25];(';
  const suffix = ');out center tags;';
  if (!query.startsWith(prefix) || !query.endsWith(suffix)) return false;

  const clausesText = query.slice(prefix.length, -suffix.length);
  const clauses = [...clausesText.matchAll(
    /nwr\["(amenity|railway|shop|leisure)"="([a-z_]+)"\]\["name"\]\(around:(\d+),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\);/g
  )];
  if (!clauses.length || clauses.map(match => match[0]).join('') !== clausesText) return false;

  return clauses.every(([, key, value, radius, lat, lon]) =>
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

    const endpointErrors = new Map();
    for (const [endpointIndex, endpoint] of OVERPASS_ENDPOINTS.entries()) {
      if (endpointIndex > 0) {
        await new Promise(resolve => setTimeout(resolve, MIRROR_DELAY_MS));
      }
      const hostname = new URL(endpoint).hostname;
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
            endpointErrors.set(hostname, `${hostname} returned status ${response.status}`);
            if (response.status !== 429 || attempt > 0) break;

            const retryDelayMs = getRetryDelay(response);
            if (retryDelayMs == null) break;

            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            continue;
          }
          return new Response(response.body, {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Upstream request failed';
          endpointErrors.set(hostname, `${hostname}: ${message}`);
          break;
        }
      }
    }

    return Response.json(
      {
        error: `${endpointErrors.size ? [...endpointErrors.values()].join('; ') : 'All Overpass mirrors failed'}. Please try again in a moment.`
      },
      { status: 502 }
    );
  }
};