// OAuth sign-in for remote MCP servers, as the MCP authorization spec has it: the server answers
// 401 → its metadata names the authorization server → HeartCode registers itself there (dynamic
// client registration, or the clientId from the config) → the browser opens the sign-in page →
// it comes back to a one-off local page with a code (PKCE) → tokens, kept in ~/.heart/mcp-auth.json
// (only readable by you) and refreshed when they expire.
import http from 'node:http'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { HOME, readJson, writeJson } from './config.js'
import { log } from './log.js'

const FILE = path.join(HOME, 'mcp-auth.json')
const b64url = (buf) => Buffer.from(buf).toString('base64url')
const store = () => readJson(FILE, {})
const keep = (url, entry) => writeJson(FILE, { ...store(), [url]: entry })
export const forget = (url) => {
  const all = store()
  delete all[url]
  writeJson(FILE, all)
}

async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { accept: 'application/json', ...init.headers }, signal: init.signal ?? AbortSignal.timeout(20_000) })
  const text = await res.text()
  if (!res.ok) throw Object.assign(new Error(`${res.status} from ${url}: ${text.slice(0, 200)}`), { status: res.status })
  return JSON.parse(text)
}

// The authorization server's endpoints for an MCP server (wwwAuth: its 401's WWW-Authenticate).
export async function discover(serverUrl, wwwAuth = '') {
  const u = new URL(serverUrl)
  const named = /resource_metadata="([^"]+)"/.exec(wwwAuth)?.[1]
  const tail = u.pathname.replace(/\/$/, '')
  let resource = {}
  for (const url of named ? [named] : [`${u.origin}/.well-known/oauth-protected-resource${tail}`, `${u.origin}/.well-known/oauth-protected-resource`]) {
    try {
      resource = await getJson(url)
      if (resource.authorization_servers?.length) break
    } catch {}
  }
  const issuer = new URL(resource.authorization_servers?.[0] ?? u.origin)
  const p = issuer.pathname.replace(/\/$/, '')
  for (const url of [`${issuer.origin}/.well-known/oauth-authorization-server${p}`, `${issuer.origin}/.well-known/openid-configuration${p}`, ...(p ? [`${issuer.origin}${p}/.well-known/openid-configuration`] : [])]) {
    try {
      const meta = await getJson(url)
      if (meta.authorization_endpoint && meta.token_endpoint) return { ...meta, scopes: resource.scopes_supported }
    } catch {}
  }
  // servers from before the metadata documents: the default endpoints
  return { authorization_endpoint: `${issuer.origin}/authorize`, token_endpoint: `${issuer.origin}/token`, registration_endpoint: `${issuer.origin}/register`, scopes: resource.scopes_supported }
}

async function tokenRequest(endpoint, params) {
  const t = await getJson(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.entries(params).filter(([, v]) => v)) })
  if (!t.access_token) throw new Error(`no access token from ${endpoint}`)
  return t
}

const entryFrom = (t, base) => ({ ...base, accessToken: t.access_token, refreshToken: t.refresh_token ?? base.refreshToken, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : null })

// The saved token for this server, refreshed first when it has expired; null when there is none
// (or it can't be refreshed): then it's time to sign in.
export async function savedToken(url, { force = false } = {}) {
  const e = store()[url]
  if (!e?.accessToken) return null
  if (!force && (!e.expiresAt || e.expiresAt > Date.now() + 60_000)) return e.accessToken
  if (!e.refreshToken) return null
  try {
    const entry = entryFrom(await tokenRequest(e.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: e.refreshToken, client_id: e.clientId, client_secret: e.clientSecret, resource: url }), e)
    keep(url, entry)
    log('oauth', `refreshed the token for ${url}`)
    return entry.accessToken
  } catch (e2) {
    log('oauth', `refresh failed for ${url}: ${e2.message}`)
    return null
  }
}

// Signs in: open(url) shows the user the sign-in page (the browser); resolves to the access token.
// opts: { clientId, clientSecret, callbackPort, scope } from the server's "oauth" config.
export async function signIn(url, wwwAuth, open, { signal, oauth = {} } = {}) {
  const meta = await discover(url, wwwAuth)
  const server = http.createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(Number(oauth.callbackPort) || 0, '127.0.0.1', resolve))
  try {
    const redirect = `http://127.0.0.1:${server.address().port}/callback`
    let client = { client_id: oauth.clientId, client_secret: oauth.clientSecret }
    if (!client.client_id) {
      if (!meta.registration_endpoint) throw new Error(`${url} has no client registration: give "oauth": { "clientId": … } in its config`)
      client = await getJson(meta.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'HeartCode', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
      })
    }
    const verifier = b64url(randomBytes(32))
    const state = b64url(randomBytes(16))
    const auth = new URL(meta.authorization_endpoint)
    const scope = oauth.scope ?? meta.scopes?.join(' ')
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state, resource: url, scope })) if (v) auth.searchParams.set(k, v)
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no sign-in within 5 minutes')), 300_000)
      signal?.addEventListener('abort', () => (clearTimeout(timer), reject(Object.assign(new Error('stopped'), { name: 'AbortError' }))), { once: true })
      server.on('request', (req, res) => {
        const q = new URL(req.url, redirect)
        if (q.pathname !== '/callback') return res.writeHead(404).end()
        const ok = q.searchParams.get('state') === state && q.searchParams.get('code')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>HeartCode</title><body style="font:16px system-ui;padding:40px">${ok ? '♥ Signed in. You can close this tab and go back to HeartCode.' : `Sign-in failed: ${String(q.searchParams.get('error_description') ?? q.searchParams.get('error') ?? 'wrong state').replace(/</g, '&lt;')}`}</body>`)
        clearTimeout(timer)
        ok ? resolve(ok) : reject(new Error(`sign-in failed: ${q.searchParams.get('error_description') ?? q.searchParams.get('error') ?? 'the reply did not match'}`))
      })
      open(auth.href)
    })
    const base = { clientId: client.client_id, clientSecret: client.client_secret, tokenEndpoint: meta.token_endpoint }
    const entry = entryFrom(await tokenRequest(meta.token_endpoint, { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, client_secret: client.client_secret, code_verifier: verifier, resource: url }), base)
    keep(url, entry)
    log('oauth', `signed in to ${url}`)
    return entry.accessToken
  } finally {
    server.close()
  }
}
