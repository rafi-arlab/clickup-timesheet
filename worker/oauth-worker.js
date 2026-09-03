// Swaps a ClickUp OAuth authorization code for an access token.
//
// This exists only because ClickUp's token endpoint requires client_secret and
// offers no PKCE, so the exchange cannot happen in the browser. It handles login
// and nothing else — every subsequent API call goes browser → ClickUp directly,
// so timesheet data never passes through here.
//
// Deliberately logs nothing: the code and token would both be credentials.

const json = (body, status, cors) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });

export default {
  async fetch(req, env) {
    const cors = {
      // exact origin, not '*' — this endpoint mints credentials
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405, cors);

    const { code } = await req.json().catch(() => ({}));
    if (!code || typeof code !== 'string') return json({ error: 'missing code' }, 400, cors);

    const url = new URL('https://api.clickup.com/api/v2/oauth/token');
    url.searchParams.set('client_id', env.CLICKUP_CLIENT_ID);
    url.searchParams.set('client_secret', env.CLICKUP_CLIENT_SECRET);
    url.searchParams.set('code', code);

    const r = await fetch(url, { method: 'POST' });
    const data = await r.json().catch(() => ({}));

    if (!r.ok || !data.access_token) {
      // pass back ClickUp's own message but never the secret or the raw body
      return json({ error: data.err || 'token exchange failed (' + r.status + ')' }, 502, cors);
    }
    return json({ access_token: data.access_token }, 200, cors);
  }
};
