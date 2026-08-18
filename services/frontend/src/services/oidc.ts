import axios from 'axios';
import { User } from '../types';
import { clearAuth, fetchMe, storeToken, storeRefreshToken } from './auth';

export interface OidcConfig {
  authority: string;
  clientId: string;
  hostedUi: string;
  scopes: string;
}

export interface AuthConfig {
  mode: 'local' | 'oidc';
  oidc?: OidcConfig;
}

// PKCE flow state lives in sessionStorage only for the duration of the redirect
const VERIFIER_KEY = 'circini_pkce_verifier';
const STATE_KEY = 'circini_oauth_state';

export async function fetchAuthConfig(): Promise<AuthConfig> {
  const response = await axios.get('/api/auth/config');
  return response.data;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function redirectUri(): string {
  return `${window.location.origin}/auth/callback`;
}

function clearFlowState() {
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
}

/** Begin the Cognito hosted-UI flow (Authorization Code + PKCE, public client). */
export async function startLogin(cfg: OidcConfig): Promise<void> {
  const verifier = randomBase64Url(64);
  const state = randomBase64Url(16);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    scope: cfg.scopes,
    redirect_uri: redirectUri(),
    state,
    code_challenge: await s256Challenge(verifier),
    code_challenge_method: 'S256',
  });
  window.location.assign(`${cfg.hostedUi}/oauth2/authorize?${params.toString()}`);
}

/**
 * Handle the /auth/callback redirect: validate state, exchange the code for
 * tokens, store the id_token under the app's existing token key, and resolve
 * the app User via /api/auth/me.
 */
export async function completeLogin(cfg: OidcConfig): Promise<User> {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const expectedState = sessionStorage.getItem(STATE_KEY);
    const verifier = sessionStorage.getItem(VERIFIER_KEY);

    if (!code) {
      throw new Error(
        params.get('error_description') || params.get('error') || 'Missing authorization code'
      );
    }
    if (!state || !expectedState || state !== expectedState) {
      throw new Error('Sign-in state mismatch — please try again');
    }
    if (!verifier) {
      throw new Error('Sign-in session expired — please try again');
    }
    sessionStorage.removeItem(STATE_KEY);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: cfg.clientId,
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    });
    const response = await axios.post(`${cfg.hostedUi}/oauth2/token`, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const idToken: string | undefined = response.data?.id_token;
    if (!idToken) {
      throw new Error('Token response did not include an id_token');
    }
    storeToken(idToken);
    if (response.data?.refresh_token) {
      storeRefreshToken(response.data.refresh_token);
    }
    const user = await fetchMe();
    clearFlowState();
    return user;
  } catch (error) {
    // A failed sign-in must leave no credential behind: the id_token is
    // stored before /me confirms it, so clear it along with the flow state.
    clearAuth();
    clearFlowState();
    throw error;
  }
}

/** Clear local auth and end the Cognito hosted-UI session. */
export function oidcLogout(cfg: OidcConfig): void {
  clearAuth();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    logout_uri: window.location.origin,
  });
  window.location.assign(`${cfg.hostedUi}/logout?${params.toString()}`);
}
