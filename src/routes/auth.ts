import { audit } from '../lib/audit';
import { clearedSessionCookie, currentAdmin, sessionCookie, signSession, verifyPassword } from '../lib/auth';
import { errorResponse, json, readJsonObject } from '../lib/http';
import type { Ctx } from '../types';

const MAX_FAILED_ATTEMPTS = 10;
// Verified against when the username does not exist, so both paths cost the same.
const DUMMY_HASH = 'pbkdf2_sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export async function login({ request, env }: Ctx): Promise<Response> {
  const body = await readJsonObject(request);
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) return errorResponse(400, 'Usuario y contraseña son requeridos.');
  if (username.length > 100 || password.length > 200) return errorResponse(401, 'El usuario o la contraseña no son correctos.');

  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type = 'auth' AND action = 'login_failed' AND comment = ? AND created_at > datetime('now', '-15 minutes')",
  )
    .bind(username)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_FAILED_ATTEMPTS) {
    return errorResponse(429, 'Demasiados intentos fallidos. Intenta de nuevo en unos minutos.');
  }

  const admin = await env.DB.prepare('SELECT id, username, full_name, email, password_hash, is_active FROM administrators WHERE username = ?')
    .bind(username)
    .first<{ id: number; username: string; full_name: string; email: string | null; password_hash: string; is_active: number }>();

  const passwordOk = await verifyPassword(password, admin?.password_hash ?? DUMMY_HASH);
  if (!admin || !passwordOk || admin.is_active !== 1) {
    await audit(env, { entity_type: 'auth', entity_id: admin?.id ?? null, action: 'login_failed', comment: username });
    return errorResponse(401, 'El usuario o la contraseña no son correctos.');
  }

  const token = await signSession(env, admin.id);
  await audit(env, { entity_type: 'auth', entity_id: admin.id, action: 'login', comment: username, admin_id: admin.id });
  return json(
    { admin: { id: admin.id, username: admin.username, full_name: admin.full_name, email: admin.email } },
    200,
    { 'set-cookie': sessionCookie(request, token) },
  );
}

export async function logout({ request, env }: Ctx): Promise<Response> {
  const admin = await currentAdmin(request, env).catch(() => null);
  if (admin) await audit(env, { entity_type: 'auth', entity_id: admin.id, action: 'logout', admin_id: admin.id });
  return json({ ok: true }, 200, { 'set-cookie': clearedSessionCookie(request) });
}

export async function me({ request, env }: Ctx): Promise<Response> {
  const admin = await currentAdmin(request, env);
  if (!admin) return errorResponse(401, 'No autenticado.');
  return json({ admin });
}
