import axios from 'axios';
import { User } from '../types';

const TOKEN_KEY = 'circini_token';
const USER_KEY = 'circini_user';
const REFRESH_KEY = 'circini_refresh_token';
const EXPIRES_KEY = 'circini_session_expires';

const DAY_MS = 24 * 60 * 60 * 1000;
/** "Keep me signed in" — matches the Cognito refresh-token lifetime. */
export const REMEMBER_DAYS = 30;
/** Without it, a sign-in lasts one working day. */
const DEFAULT_SESSION_MS = DAY_MS;

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function storeRefreshToken(token: string) {
  localStorage.setItem(REFRESH_KEY, token);
}

export function getStoredUser(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Store just the session token (used by the OIDC flow before /auth/me resolves the user). */
export function storeToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

function storeAuth(token: string, user: User) {
  storeToken(token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/**
 * Begin a Cognito session. The refresh token itself is valid for
 * REMEMBER_DAYS; without "keep me signed in" the app stops renewing after a
 * day and revokes it, so the choice is enforced by Cognito, not only locally.
 */
export function startSession(idToken: string, refreshToken: string | undefined, remember: boolean) {
  storeToken(idToken);
  if (refreshToken) storeRefreshToken(refreshToken);
  const lifetime = remember ? REMEMBER_DAYS * DAY_MS : DEFAULT_SESSION_MS;
  localStorage.setItem(EXPIRES_KEY, String(Date.now() + lifetime));
}

function sessionExpired(): boolean {
  const expires = Number(localStorage.getItem(EXPIRES_KEY));
  return Number.isFinite(expires) && expires > 0 && Date.now() >= expires;
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(EXPIRES_KEY);
}

interface CognitoClient {
  endpoint: string;
  clientId: string;
}

/** The Cognito API endpoint and app client, or null outside oidc mode. */
async function cognitoClient(): Promise<CognitoClient | null> {
  // /api/auth/config is public; use bare axios so this never recurses
  // through the app client's 401 interceptor.
  const { data: cfg } = await axios.get('/api/auth/config');
  if (cfg?.mode !== 'oidc' || !cfg.oidc?.authority || !cfg.oidc?.clientId) return null;
  return { endpoint: `${new URL(cfg.oidc.authority).origin}/`, clientId: cfg.oidc.clientId };
}

function cognitoCall(client: CognitoClient, action: string, body: object) {
  return axios.post(client.endpoint, JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
    },
    timeout: 5000,
  });
}

/** Revoke the stored refresh token so it cannot mint new sessions. Best effort. */
async function revokeRefreshToken(): Promise<void> {
  const token = getRefreshToken();
  if (!token) return;
  try {
    const client = await cognitoClient();
    if (client) await cognitoCall(client, 'RevokeToken', { Token: token, ClientId: client.clientId });
  } catch {
    // The token still expires on its own; signing out must not wait on this.
  }
}

/**
 * Silently renew the Cognito ID token using the stored refresh token.
 * Returns the new token, or null when renewal isn't possible (local auth
 * mode, no refresh token, or the refresh token itself expired/revoked).
 */
export async function refreshIdToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  if (sessionExpired()) {
    await revokeRefreshToken();
    clearAuth();
    return null;
  }
  try {
    const client = await cognitoClient();
    if (!client) return null;
    const response = await cognitoCall(client, 'InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: client.clientId,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    });
    const idToken: string | undefined = response.data?.AuthenticationResult?.IdToken;
    if (!idToken) return null;
    storeToken(idToken);
    return idToken;
  } catch {
    return null;
  }
}

export async function login(email: string, password: string): Promise<User> {
  const response = await axios.post('/api/auth/login', { email, password });
  const { token, user } = response.data;
  storeAuth(token, user);
  return user;
}

export async function fetchMe(): Promise<User> {
  const response = await axios.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  localStorage.setItem(USER_KEY, JSON.stringify(response.data));
  return response.data;
}

/**
 * Resolve the signed-in user on page load. The ID token lives five minutes,
 * so a returning user usually holds an expired one: renew it once and retry
 * instead of sending them back to the sign-in page.
 */
export async function restoreSession(): Promise<User> {
  try {
    return await fetchMe();
  } catch (error: any) {
    if (error?.response?.status !== 401) throw error;
    if (!(await refreshIdToken())) throw error;
    return fetchMe();
  }
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await axios.post(
    '/api/auth/change-password',
    { currentPassword, newPassword },
    { headers: { Authorization: `Bearer ${getToken()}` } }
  );
}

export async function logout() {
  await revokeRefreshToken();
  clearAuth();
  window.location.reload();
}
