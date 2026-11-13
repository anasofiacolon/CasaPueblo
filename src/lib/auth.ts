import type { AdminSession, Env } from '../types';
import { HttpError } from './http';

// ---------- encoding helpers ----------
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (text: string) => unb64(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------- password hashing: PBKDF2-SHA256 via Web Crypto ----------
// Format: pbkdf2_sha256$<iterations>$<salt b64>$<hash b64>
// 100,000 is the maximum iteration count workerd accepts for PBKDF2.
export const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterText, saltText, hashText] = stored.split('$');
  const iterations = Number(iterText);
  if (scheme !== 'pbkdf2_sha256' || !Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS || !saltText || !hashText) {
    return false;
  }
  try {
    const expected = unb64(hashText);
    return timingSafeEqual(await pbkdf2(password, unb64(saltText), iterations), expected);
  } catch {
    return false;
  }
}

// ---------- session JWT (HS256) in an HttpOnly cookie ----------
export const SESSION_COOKIE = 'cp_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

function secret(env: Env): string {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 16) {
    throw new HttpError(500, 'JWT_SECRET no está configurado en el servidor.');
  }
  return env.JWT_SECRET;
}

async function hmacKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(env: Env, adminId: number, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(enc.encode(JSON.stringify({ sub: adminId, iat, exp: iat + SESSION_TTL_SECONDS })));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

/** Returns the admin id in a valid, unexpired token; otherwise null. */
export async function verifySession(env: Env, token: string, now = Date.now()): Promise<number | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(dec.decode(unb64url(parts[0])));
    if (header.alg !== 'HS256') return null;
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), unb64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(unb64url(parts[1])));
    if (!Number.isInteger(payload.sub) || typeof payload.exp !== 'number' || payload.exp <= Math.floor(now / 1000)) return null;
    return payload.sub;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return null;
  }
}

function cookieAttributes(request: Request): string {
  // Secure is required in production; plain-http localhost dev would drop the cookie in some browsers.
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export function sessionCookie(request: Request, token: string): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_TTL_SECONDS}; ${cookieAttributes(request)}`;
}

export function clearedSessionCookie(request: Request): string {
  return `${SESSION_COOKIE}=; Max-Age=0; ${cookieAttributes(request)}`;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The authenticated, still-active administrator for this request, or null. */
export async function currentAdmin(request: Request, env: Env): Promise<AdminSession | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const id = await verifySession(env, token);
  if (id === null) return null;
  return env.DB.prepare('SELECT id, username, full_name, email FROM administrators WHERE id = ? AND is_active = 1')
    .bind(id)
    .first<AdminSession>();
}
