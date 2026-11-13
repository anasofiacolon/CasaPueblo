import { auditStatement } from '../lib/audit';
import { hashPassword } from '../lib/auth';
import { HttpError, flag, isEmail, json, optionalText, readJsonObject, requiredText } from '../lib/http';
import type { Ctx } from '../types';

const MIN_PASSWORD = 8;
const SELECT = 'SELECT id, username, full_name, email, is_active, created_at FROM administrators';

function username(value: unknown): string {
  const u = requiredText(value, 'username', 50).toLowerCase();
  if (!/^[a-z0-9._-]{3,50}$/.test(u)) throw new HttpError(400, 'El usuario debe tener 3–50 caracteres: letras, números, punto, guion o guion bajo.');
  return u;
}

function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD || value.length > 200) {
    throw new HttpError(400, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
  }
  return value;
}

function email(value: unknown): string | null {
  const e = optionalText(value, 'email', 254);
  if (e && !isEmail(e)) throw new HttpError(400, 'El correo no es válido.');
  return e;
}

function uniqueViolation(err: unknown): never {
  if (String((err as Error)?.message).includes('UNIQUE')) throw new HttpError(409, 'Ese usuario o correo ya existe.');
  throw err;
}

export async function listAdmins({ env }: Ctx): Promise<Response> {
  const { results } = await env.DB.prepare(`${SELECT} ORDER BY full_name COLLATE NOCASE`).all();
  return json({ administrators: results });
}

export async function createAdmin(ctx: Ctx): Promise<Response> {
  const { env, request } = ctx;
  const b = await readJsonObject(request);
  const row = { username: username(b.username), full_name: requiredText(b.full_name, 'full_name', 200), email: email(b.email) };
  const hash = await hashPassword(password(b.password));
  const result = await env.DB.prepare('INSERT INTO administrators (username, password_hash, full_name, email) VALUES (?, ?, ?, ?)')
    .bind(row.username, hash, row.full_name, row.email)
    .run()
    .catch(uniqueViolation);
  const id = result.meta.last_row_id;
  await auditStatement(env, { entity_type: 'auth', entity_id: id, action: 'admin_create', new_state: row, admin_id: ctx.admin!.id }).run();
  return json({ administrator: await env.DB.prepare(`${SELECT} WHERE id = ?`).bind(id).first() }, 201);
}

export async function updateAdmin(ctx: Ctx): Promise<Response> {
  const { env, request, params } = ctx;
  const current = await env.DB.prepare(`${SELECT} WHERE id = ?`).bind(Number(params.id)).first<{ id: number; username: string; full_name: string; email: string | null; is_active: number }>();
  if (!current) throw new HttpError(404, 'Administrador no encontrado.');
  const b = await readJsonObject(request);
  const next = {
    username: b.username === undefined ? current.username : username(b.username),
    full_name: b.full_name === undefined ? current.full_name : requiredText(b.full_name, 'full_name', 200),
    email: b.email === undefined ? current.email : email(b.email),
    is_active: flag(b.is_active, 'is_active', current.is_active as 0 | 1),
  };
  if (current.is_active === 1 && next.is_active === 0) {
    const others = await env.DB.prepare('SELECT COUNT(*) AS n FROM administrators WHERE is_active = 1 AND id != ?').bind(current.id).first<{ n: number }>();
    if ((others?.n ?? 0) === 0) throw new HttpError(409, 'Debe existir al menos un administrador activo.');
  }
  const statements = [
    env.DB.prepare('UPDATE administrators SET username = ?, full_name = ?, email = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(
      next.username, next.full_name, next.email, next.is_active, current.id,
    ),
  ];
  // The password only changes when a new one is supplied; it is never read back.
  const changedPassword = b.password !== undefined && b.password !== null && b.password !== '';
  if (changedPassword) {
    statements.push(env.DB.prepare('UPDATE administrators SET password_hash = ? WHERE id = ?').bind(await hashPassword(password(b.password)), current.id));
  }
  statements.push(
    auditStatement(env, {
      entity_type: 'auth', entity_id: current.id, action: 'admin_update',
      previous_state: { username: current.username, full_name: current.full_name, email: current.email, is_active: current.is_active },
      new_state: { ...next, password_changed: changedPassword }, admin_id: ctx.admin!.id,
    }),
  );
  await env.DB.batch(statements).catch(uniqueViolation);
  return json({ administrator: await env.DB.prepare(`${SELECT} WHERE id = ?`).bind(current.id).first() });
}

export async function stats({ env }: Ctx): Promise<Response> {
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM submissions WHERE status = 'pending') AS pending_submissions,
       (SELECT COUNT(*) FROM communities WHERE is_visible = 1 AND deleted_at IS NULL) AS published_communities,
       (SELECT COUNT(*) FROM communities WHERE is_visible = 0 AND deleted_at IS NULL) AS hidden_communities`,
  ).first();
  const { results: recent } = await env.DB.prepare('SELECT id, community_name, status, created_at FROM submissions ORDER BY created_at DESC, id DESC LIMIT 8').all();
  return json({ ...counts, recent_submissions: recent });
}
