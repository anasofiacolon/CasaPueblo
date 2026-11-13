import { SELF, env } from 'cloudflare:test';
import { hashPassword } from '../src/lib/auth';

export const BASE = 'https://casapueblo.test';
export const db = () => (env as any).DB as D1Database;

export async function createAdmin(username: string, password = 'correct-horse-battery', active = 1): Promise<number> {
  const result = await db()
    .prepare('INSERT INTO administrators (username, password_hash, full_name, is_active) VALUES (?, ?, ?, ?)')
    .bind(username, await hashPassword(password), `Admin ${username}`, active)
    .run();
  return result.meta.last_row_id as number;
}

export function request(path: string, init: RequestInit & { json?: unknown; cookie?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(init.json);
    init.method ??= 'POST';
  }
  if (init.cookie) headers.set('cookie', init.cookie);
  return SELF.fetch(BASE + path, { ...init, headers, redirect: 'manual' });
}

/** Logs in and returns the `name=value` cookie pair to send back. */
export async function loginCookie(username: string, password = 'correct-horse-battery'): Promise<string> {
  const res = await request('/api/auth/login', { json: { username, password } });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return res.headers.get('set-cookie')!.split(';')[0];
}
