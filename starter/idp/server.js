'use strict';

// Mock identity provider: OpenID Connect, authorization code flow with PKCE.
// Zero dependencies. It behaves like a real IdP (Google, Auth0, Okta) for the
// parts you need: discovery, /authorize, /token, /userinfo, /jwks.
//
// Instead of a password form, /authorize shows a list of test users.

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4020);
const ISSUER = process.env.IDP_ISSUER || 'http://localhost:' + PORT;
const CLIENT_ID = process.env.IDP_CLIENT_ID || 'switchboard-web';
const CLIENT_SECRET = process.env.IDP_CLIENT_SECRET || 'dev-secret-not-for-production';
const REDIRECTS = (process.env.IDP_REDIRECT_URIS || 'http://localhost:3000/auth/callback,http://localhost:4000/auth/callback,http://localhost:5173/auth/callback').split(',');

const USERS = [
  { sub: 'u_asha', name: 'Asha Rao', email: 'asha@acme.test', workspaces: [{ id: 'ws_acme', role: 'admin' }] },
  { sub: 'u_ben', name: 'Ben Ortiz', email: 'ben@acme.test', workspaces: [{ id: 'ws_acme', role: 'agent' }] },
  { sub: 'u_chloe', name: 'Chloe Martin', email: 'chloe@globex.test', workspaces: [{ id: 'ws_globex', role: 'admin' }] },
  { sub: 'u_dev', name: 'Dev Patel', email: 'dev@globex.test', workspaces: [{ id: 'ws_globex', role: 'agent' }] },
  { sub: 'u_eli', name: 'Eli Novak (contractor)', email: 'eli@contractor.test', workspaces: [{ id: 'ws_acme', role: 'agent' }, { id: 'ws_globex', role: 'agent' }] },
];

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = crypto.randomBytes(6).toString('hex');
const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: KID, use: 'sig', alg: 'RS256' });
const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

function signJwt(claims) {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: KID });
  const body = b64(claims);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(head + '.' + body), privateKey).toString('base64url');
  return head + '.' + body + '.' + sig;
}

const codes = new Map(); // code -> { user, redirectUri, challenge, nonce, exp }
const tokens = new Map(); // access token -> user

function readForm(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if ((req.headers['content-type'] || '').includes('json')) {
        try {
          return resolve(JSON.parse(raw));
        } catch (e) {
          return resolve({});
        }
      }
      resolve(Object.fromEntries(new URLSearchParams(raw)));
    });
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, ISSUER);
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return json(204, {});

    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: ISSUER,
        authorization_endpoint: ISSUER + '/authorize',
        token_endpoint: ISSUER + '/token',
        userinfo_endpoint: ISSUER + '/userinfo',
        jwks_uri: ISSUER + '/jwks',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'profile', 'email'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });

    if (url.pathname === '/authorize') {
      const q = Object.fromEntries(url.searchParams);
      if (q.client_id !== CLIENT_ID) return json(400, { error: 'unauthorized_client' });
      if (!REDIRECTS.includes(q.redirect_uri)) return json(400, { error: 'invalid_request', error_description: 'redirect_uri not registered: ' + q.redirect_uri });
      if (q.response_type !== 'code') return json(400, { error: 'unsupported_response_type' });
      if (!q.code_challenge || q.code_challenge_method !== 'S256') return json(400, { error: 'invalid_request', error_description: 'PKCE with S256 is required' });
      if (q.login) {
        const user = USERS.find((u) => u.sub === q.login);
        if (!user) return json(400, { error: 'access_denied' });
        const code = crypto.randomBytes(16).toString('hex');
        codes.set(code, { user, redirectUri: q.redirect_uri, challenge: q.code_challenge, nonce: q.nonce, exp: Date.now() + 60000 });
        const back = new URL(q.redirect_uri);
        back.searchParams.set('code', code);
        if (q.state) back.searchParams.set('state', q.state);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      const links = USERS.map((u) => {
        const next = new URL(url);
        next.searchParams.set('login', u.sub);
        const roles = u.workspaces.map((w) => w.id + ' (' + w.role + ')').join(', ');
        return '<li><a href="' + next.pathname + next.search.replace(/"/g, '&quot;') + '">' + u.name + '</a> <small>' + u.email + ' · ' + roles + '</small></li>';
      }).join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><title>Mock IdP</title><body style="font:16px system-ui;max-width:560px;margin:60px auto"><h2>Mock identity provider</h2><p>Sign in as:</p><ul style="line-height:2">' + links + '</ul></body>');
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const f = await readForm(req);
      let id = f.client_id;
      let secret = f.client_secret;
      const basic = (req.headers.authorization || '').match(/^Basic (.+)$/);
      if (basic) [id, secret] = Buffer.from(basic[1], 'base64').toString().split(':');
      if (id !== CLIENT_ID) return json(401, { error: 'invalid_client' });
      // Public clients (SPA) may omit the secret; if one is sent it must be right.
      if (secret !== undefined && secret !== '' && secret !== CLIENT_SECRET) return json(401, { error: 'invalid_client' });
      const entry = codes.get(f.code);
      codes.delete(f.code); // single use
      if (f.grant_type !== 'authorization_code' || !entry || entry.exp < Date.now()) return json(400, { error: 'invalid_grant' });
      if (entry.redirectUri !== f.redirect_uri) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      const challenge = crypto.createHash('sha256').update(String(f.code_verifier || '')).digest('base64url');
      if (challenge !== entry.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      const now = Math.floor(Date.now() / 1000);
      const u = entry.user;
      const access = 'at_' + crypto.randomBytes(18).toString('hex');
      tokens.set(access, u);
      return json(200, {
        access_token: access,
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: signJwt({ iss: ISSUER, aud: CLIENT_ID, sub: u.sub, iat: now, exp: now + 3600, nonce: entry.nonce, name: u.name, email: u.email, workspaces: u.workspaces }),
      });
    }

    if (url.pathname === '/userinfo') {
      const u = tokens.get(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      if (!u) return json(401, { error: 'invalid_token' });
      return json(200, { sub: u.sub, name: u.name, email: u.email, workspaces: u.workspaces });
    }

    json(404, { error: 'not_found' });
  })
  .listen(PORT, () => console.log('mock idp on ' + ISSUER + '  client_id=' + CLIENT_ID));
