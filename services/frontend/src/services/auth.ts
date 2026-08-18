import axios from 'axios';
import { User } from '../types';

const TOKEN_KEY = 'circini_token';
const USER_KEY = 'circini_user';
const REFRESH_KEY = 'circini_refresh_token';

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

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

/**
 * Silently renew the Cognito ID token using the stored refresh token.
 * Returns the new token, or null when renewal isn't possible (local auth
 * mode, no refresh token, or the refresh token itself expired/revoked).
 */
export async function refreshIdToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  try {
    // /api/auth/config is public; use bare axios so this never recurses
    // through the app client's 401 interceptor.
    const { data: cfg } = await axios.get('/api/auth/config');
    if (cfg?.mode !== 'oidc' || !cfg.oidc?.authority || !cfg.oidc?.clientId) return null;

    const endpoint = `${new URL(cfg.oidc.authority).origin}/`;
    const response = await axios.post(
      endpoint,
      JSON.stringify({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: cfg.oidc.clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }),
      {
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
        },
      }
    );
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

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await axios.post(
    '/api/auth/change-password',
    { currentPassword, newPassword },
    { headers: { Authorization: `Bearer ${getToken()}` } }
  );
}

export function logout() {
  clearAuth();
  window.location.reload();
}
