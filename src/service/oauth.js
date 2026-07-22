// Google OAuth via chrome.identity.launchWebAuthFlow (HTTPS redirect: *.chromiumapp.org).
import { user, secrets } from '../dao/index.js';

const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

function sessionActive(user, secrets) {
  if (!user?.email) return false;
  // 0 = explicitly signed out / no session. Only fall back when the field is missing.
  const raw = secrets?.sessionExpiresAt;
  const expires = (raw == null)
    ? (user.signedInAt ? user.signedInAt + SESSION_TTL_MS : 0)
    : Number(raw) || 0;
  return expires > Date.now();
}

function scopes() {
  return chrome.runtime.getManifest().oauth2?.scopes || [];
}

function clientId() {
  const id = chrome.runtime.getManifest().oauth2?.client_id;
  if (!id || id.startsWith('REPLACE_')) {
    throw new Error('Set oauth2.client_id in manifest.json (Web application OAuth client).');
  }
  return id;
}

export function getRedirectUri() {
  return chrome.identity.getRedirectURL();
}

function parseTokenResponse(responseUrl) {
  const u = new URL(responseUrl);
  const params = new URLSearchParams(u.hash.replace(/^#/, '') || u.search.replace(/^\?/, ''));
  if (params.get('error')) {
    throw new Error(params.get('error_description') || params.get('error') || 'OAuth error');
  }
  const accessToken = params.get('access_token');
  if (!accessToken) throw new Error('No access_token in OAuth redirect');
  return { accessToken, expiresAt: Date.now() + Number(params.get('expires_in') || 3600) * 1000 };
}

async function launchAuth(interactive) {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: 'token',
    redirect_uri: getRedirectUri(),
    scope: scopes().join(' '),
    prompt: interactive ? 'select_account' : 'none',
  });
  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, interactive },
      (url) => (chrome.runtime.lastError || !url)
        ? reject(new Error(chrome.runtime.lastError?.message || 'Sign-in cancelled'))
        : resolve(url),
    );
  });
  const { accessToken, expiresAt } = parseTokenResponse(responseUrl);
  await secrets.put({ accessToken, expiresAt });
  return accessToken;
}

export async function getAccessToken(interactive = true) {
  const [u, sec] = await Promise.all([user.get(), secrets.get()]);
  const active = sessionActive(u, sec);

  if (!active) {
    if (!interactive) throw new Error('Session expired — sign in again');
  } else if (sec.accessToken && sec.expiresAt > Date.now() + 60_000) {
    return sec.accessToken;
  }

  if (!interactive) {
    try { return await launchAuth(false); } catch { throw new Error('Not signed in'); }
  }
  return launchAuth(true);
}

export const getToken = getAccessToken;

export async function clearAccessToken() {
  const sec = await secrets.get();
  if (sec.accessToken) {
    await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(sec.accessToken)}`).catch(() => {});
  }
  await secrets.put({ accessToken: '', expiresAt: 0 });
}

export async function signIn() {
  const token = await launchAuth(true);
  const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`userinfo failed: ${res.status}`);
  const u = await res.json();
  const signedInAt = Date.now();
  await user.post({
    email: u.email,
    name: u.name || '',
    picture: u.picture || '',
    signedInAt,
    googleSub: u.sub || '',
  });
  await secrets.put({ sessionExpiresAt: signedInAt + SESSION_TTL_MS });
  return getUser();
}

/** Read-only session check — never revokes tokens or clears secrets. */
export async function getUser() {
  const [u, sec] = await Promise.all([user.get(), secrets.get()]);
  if (!sessionActive(u, sec)) return null;
  return {
    email: u.email,
    name: u.name || '',
    picture: u.picture || '',
    signedInAt: u.signedInAt || 0,
    googleSub: u.googleSub || '',
    sessionExpiresAt: sec.sessionExpiresAt || 0,
  };
}

export async function signOut() {
  await clearAccessToken();
  await secrets.put({ sessionExpiresAt: 0, accessToken: '', expiresAt: 0 });
}
