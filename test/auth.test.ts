import { beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/auth';
import { createAdmin, db, loginCookie, request } from './helpers';

beforeAll(async () => {
  await createAdmin('auth-admin');
  await createAdmin('auth-inactive', 'correct-horse-battery', 0);
});

describe('password hashing', () => {
  it('uses the documented PBKDF2-SHA256 format and verifies round trips', async () => {
    const hash = await hashPassword('s3creta-larga');
    expect(hash).toMatch(/^pbkdf2_sha256\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword('s3creta-larga', hash)).toBe(true);
    expect(await verifyPassword('otra', hash)).toBe(false);
    expect(await verifyPassword('s3creta-larga', 'not-a-hash')).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });
});

describe('POST /api/auth/login', () => {
  it('returns 200 and an HttpOnly, SameSite=Lax, Secure cookie for valid credentials', async () => {
    const res = await request('/api/auth/login', { json: { username: 'auth-admin', password: 'correct-horse-battery' } });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^cp_session=[\w-]+\.[\w-]+\.[\w-]+;/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    const body = (await res.json()) as any;
    expect(body.admin.username).toBe('auth-admin');
    expect(JSON.stringify(body)).not.toContain('pbkdf2');
  });

  it('returns 401 for a wrong password, an unknown user and an inactive account, with the same message', async () => {
    const attempts = [
      { username: 'auth-admin', password: 'wrong' },
      { username: 'nobody', password: 'correct-horse-battery' },
      { username: 'auth-inactive', password: 'correct-horse-battery' },
    ];
    const messages = new Set<string>();
    for (const json of attempts) {
      const res = await request('/api/auth/login', { json });
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
      messages.add(((await res.json()) as any).error);
    }
    expect(messages.size).toBe(1);
  });

  it('returns 400 when fields are missing or the body is not JSON', async () => {
    expect((await request('/api/auth/login', { json: { username: 'auth-admin' } })).status).toBe(400);
    expect((await request('/api/auth/login', { json: { password: 'x' } })).status).toBe(400);
    expect((await request('/api/auth/login', { json: {} })).status).toBe(400);
    expect((await request('/api/auth/login', { method: 'POST', body: 'not json' })).status).toBe(400);
  });

  it('records successful and failed logins in audit_logs', async () => {
    await request('/api/auth/login', { json: { username: 'auth-admin', password: 'bad-for-audit' } });
    await loginCookie('auth-admin');
    const { results } = await db().prepare("SELECT action FROM audit_logs WHERE entity_type = 'auth' AND comment = 'auth-admin'").all<{ action: string }>();
    const actions = results.map((r) => r.action);
    expect(actions).toContain('login');
    expect(actions).toContain('login_failed');
  });

  it('locks out a username after repeated failures', async () => {
    await createAdmin('auth-lockout');
    for (let i = 0; i < 10; i++) {
      expect((await request('/api/auth/login', { json: { username: 'auth-lockout', password: 'wrong' } })).status).toBe(401);
    }
    // Even the correct password is refused while the lockout window is open.
    expect((await request('/api/auth/login', { json: { username: 'auth-lockout', password: 'correct-horse-battery' } })).status).toBe(429);
  });
});

describe('session', () => {
  it('GET /api/auth/me is 401 without a session and returns the admin with one', async () => {
    expect((await request('/api/auth/me')).status).toBe(401);
    const cookie = await loginCookie('auth-admin');
    const res = await request('/api/auth/me', { cookie });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).admin).toMatchObject({ username: 'auth-admin', full_name: 'Admin auth-admin' });
  });

  it('rejects tampered and garbage tokens', async () => {
    const cookie = await loginCookie('auth-admin');
    const [header, payload, signature] = cookie.split('=')[1].split('.');
    const forged = btoa(JSON.stringify({ sub: 1, iat: 1, exp: 9999999999 })).replace(/=+$/, '');
    for (const token of [`${header}.${forged}.${signature}`, `${header}.${payload}.AAAA`, 'garbage', '']) {
      expect((await request('/api/auth/me', { cookie: `cp_session=${token}` })).status).toBe(401);
    }
  });

  it('POST /api/auth/logout clears the cookie', async () => {
    const cookie = await loginCookie('auth-admin');
    const res = await request('/api/auth/logout', { method: 'POST', cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^cp_session=; Max-Age=0/);
  });

  it('a session stops working as soon as the account is deactivated', async () => {
    const id = await createAdmin('auth-revoked');
    const cookie = await loginCookie('auth-revoked');
    expect((await request('/api/admin/stats', { cookie })).status).toBe(200);
    await db().prepare('UPDATE administrators SET is_active = 0 WHERE id = ?').bind(id).run();
    expect((await request('/api/admin/stats', { cookie })).status).toBe(401);
  });
});

describe('route protection', () => {
  const adminRoutes: [string, string][] = [
    ['GET', '/api/admin/stats'],
    ['GET', '/api/admin/submissions'],
    ['GET', '/api/admin/submissions/1'],
    ['POST', '/api/admin/submissions/1/approve'],
    ['POST', '/api/admin/submissions/1/reject'],
    ['GET', '/api/admin/communities'],
    ['POST', '/api/admin/communities'],
    ['PUT', '/api/admin/communities/1'],
    ['DELETE', '/api/admin/communities/1'],
    ['PUT', '/api/admin/project-info/vision'],
    ['GET', '/api/admin/administrators'],
    ['POST', '/api/admin/administrators'],
    ['PUT', '/api/admin/administrators/1'],
    ['GET', '/api/admin/does-not-exist'],
  ];

  it.each(adminRoutes)('%s %s is 401 without a session', async (method, path) => {
    const res = await request(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
    expect(res.status).toBe(401);
  });

  it('admin routes work with a session', async () => {
    const cookie = await loginCookie('auth-admin');
    expect((await request('/api/admin/stats', { cookie })).status).toBe(200);
    expect((await request('/api/admin/administrators', { cookie })).status).toBe(200);
  });

  it('never returns password hashes from the administrators API', async () => {
    const cookie = await loginCookie('auth-admin');
    const text = await (await request('/api/admin/administrators', { cookie })).text();
    expect(text).not.toContain('password');
    expect(text).not.toContain('pbkdf2');
  });

  it('refuses cross-origin writes even with a valid cookie', async () => {
    const cookie = await loginCookie('auth-admin');
    const res = await request('/api/admin/communities', { json: { name: 'x' }, cookie, headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  it('redirects protected admin pages to the login page without a session', async () => {
    for (const page of ['dashboard', 'submissions', 'submission', 'comunidades', 'administradores']) {
      for (const path of [`/admin/${page}.html`, `/admin/${page}`]) {
        const res = await request(path);
        expect(res.status, path).toBe(302);
        expect(res.headers.get('location'), path).toBe('https://casapueblo.test/admin/login.html');
      }
    }
  });

  it('serves the login page without a session and protected pages with one', async () => {
    expect((await request('/admin/login')).status).toBe(200);
    const cookie = await loginCookie('auth-admin');
    const res = await request('/admin/dashboard', { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('Dashboard');
  });

  it('refuses to deactivate the last active administrator', async () => {
    // Deactivate everyone but one, then try to deactivate that one.
    const cookie = await loginCookie('auth-admin');
    const { administrators } = (await (await request('/api/admin/administrators', { cookie })).json()) as any;
    const me = administrators.find((a: any) => a.username === 'auth-admin');
    await db().prepare('UPDATE administrators SET is_active = 0 WHERE id != ?').bind(me.id).run();
    const res = await request(`/api/admin/administrators/${me.id}`, { method: 'PUT', json: { is_active: false }, cookie });
    expect(res.status).toBe(409);
    await db().prepare("UPDATE administrators SET is_active = 1 WHERE username != 'auth-inactive' AND username != 'auth-revoked'").run();
  });
});

describe('GET /api/health', () => {
  it('reports database connectivity', async () => {
    const res = await request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', database: 'connected' });
  });
});
