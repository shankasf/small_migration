import axios from 'axios';
import { User } from '../types';

const TOKEN_KEY = 'circini_token';
const USER_KEY = 'circini_user';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
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
