// Login + API relay for the ClickUp timesheet.
//
// Two reasons this Worker exists, both forced by ClickUp:
//
// 1. POST /exchange — ClickUp's token endpoint needs client_secret and offers no
//    PKCE, so the code→token swap cannot happen in a browser.
// 2. /api/v2/* — ClickUp returns CORS headers on the preflight but NOT on the
//    actual response to an OAuth Bearer request. The reply arrives 200 and the
//    browser discards it. Relaying server-side sidesteps that entirely.
//
// The caller's Authorization header is passed straight through and never stored.
// Deliberately logs nothing: codes and tokens are both credentials.

const UPSTREAM = 'https://api.clickup.com';

const corsFor = env => ({
  // exact origin, not '*' — this endpoint handles credentials
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  // the app reads this to time its 429 backoff; cross-origin JS can't see
  // non-simple headers unless they're explicitly exposed
  'Access-Control-Expose-Headers': 'X-RateLimit-Reset, X-RateLimit-Remaining',
  'Vary': 'Origin'
});

const json = (body, status, cors) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });

// Swap a single-use authorization code for an access token.
async function exchange(req, env, cors) {
  const { code } = await req.json().catch(() => ({}));
  if (!code || typeof code !== 'string') return json({ error: 'missing code' }, 400, cors);

  const url = new URL(UPSTREAM + '/api/v2/oauth/token');
  url.searchParams.set('client_id', env.CLICKUP_CLIENT_ID);
  url.searchParams.set('client_secret', env.CLICKUP_CLIENT_SECRET);
  url.searchParams.set('code', code);

  const r = await fetch(url, { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    // relay ClickUp's own message, never the secret or the raw body
    return json({ error: data.err || 'token exchange failed (' + r.status + ')' }, 502, cors);
  }
  return json({ access_token: data.access_token }, 200, cors);
}

// Relay an API call, carrying the caller's token and ClickUp's status through.
async function relay(req, url, cors) {
  const auth = req.headers.get('Authorization');
  if (!auth) return json({ err: 'missing authorization' }, 401, cors);

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const r = await fetch(UPSTREAM + url.pathname + url.search, {
    method: req.method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: hasBody ? await req.text() : undefined
  });

  const body = await r.text();
  const headers = {
    ...cors,
    'Content-Type': r.headers.get('Content-Type') || 'application/json'
  };
  // keep the app's rate-limit backoff working
  for (const h of ['x-ratelimit-reset', 'x-ratelimit-remaining']) {
    const v = r.headers.get(h);
    if (v) headers[h] = v;
  }
  return new Response(body, { status: r.status, headers });
}

export default {
  async fetch(req, env) {
    const cors = corsFor(env);
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (url.pathname === '/exchange') {
      if (req.method !== 'POST') return json({ error: 'POST only' }, 405, cors);
      return exchange(req, env, cors);
    }

    // fixed upstream host and a fixed path prefix, so this can't be pointed elsewhere
    if (url.pathname.startsWith('/api/v2/')) return relay(req, url, cors);

    return json({ error: 'not found' }, 404, cors);
  }
};
