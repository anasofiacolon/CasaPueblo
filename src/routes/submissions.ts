import { auditStatement } from '../lib/audit';
import { communityDbHash, uniqueSlug } from '../lib/communities';
import { HttpError, coordinates, errorResponse, flag, isEmail, json, optionalText, readJsonObject, requiredText } from '../lib/http';
import type { Ctx } from '../types';

interface SubmissionRow {
  id: number;
  community_name: string;
  location_text: string | null;
  latitude: number | null;
  longitude: number | null;
  description: string;
  energy_initiative_details: string;
  submitter_name: string | null;
  submitter_email: string;
  submitter_phone: string | null;
  submitter_comments: string | null;
  show_community_name: 0 | 1;
  show_location: 0 | 1;
  show_description: 0 | 1;
  show_energy_initiative_details: 0 | 1;
  show_submitter_name: 0 | 1;
  show_submitter_email: 0 | 1;
  show_submitter_phone: 0 | 1;
  status: 'pending' | 'approved' | 'rejected';
  rejection_comment: string | null;
  reviewed_by_admin_id: number | null;
  reviewed_at: string | null;
  created_at: string;
}

/** POST /api/submissions — public. Location is optional and hidden unless the submitter opts in. */
export async function createSubmission({ request, env }: Ctx): Promise<Response> {
  const b = await readJsonObject(request);
  const email = requiredText(b.submitter_email, 'submitter_email', 254);
  if (!isEmail(email)) throw new HttpError(400, 'El correo de contacto no es válido.');
  const { latitude, longitude } = coordinates(b.latitude, b.longitude);

  const result = await env.DB.prepare(
    `INSERT INTO submissions (community_name, location_text, latitude, longitude, description, energy_initiative_details,
       submitter_name, submitter_email, submitter_phone, submitter_comments,
       show_community_name, show_location, show_description, show_energy_initiative_details,
       show_submitter_name, show_submitter_email, show_submitter_phone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      requiredText(b.community_name, 'community_name', 200),
      optionalText(b.location_text, 'location_text', 300),
      latitude,
      longitude,
      requiredText(b.description, 'description'),
      requiredText(b.energy_initiative_details, 'energy_initiative_details'),
      optionalText(b.submitter_name, 'submitter_name', 200),
      email,
      optionalText(b.submitter_phone, 'submitter_phone', 50),
      optionalText(b.submitter_comments, 'submitter_comments'),
      flag(b.show_community_name, 'show_community_name', 1),
      flag(b.show_location, 'show_location', 0),
      flag(b.show_description, 'show_description', 1),
      flag(b.show_energy_initiative_details, 'show_energy_initiative_details', 1),
      flag(b.show_submitter_name, 'show_submitter_name', 0),
      flag(b.show_submitter_email, 'show_submitter_email', 0),
      flag(b.show_submitter_phone, 'show_submitter_phone', 0),
    )
    .run();
  // Nothing about the stored submission is echoed back: the public only learns it was received.
  return json({ ok: true, id: result.meta.last_row_id, status: 'pending' }, 201);
}

export async function listSubmissions({ env, url }: Ctx): Promise<Response> {
  const status = url.searchParams.get('status');
  const q = url.searchParams.get('q')?.trim();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    if (!['pending', 'approved', 'rejected'].includes(status)) throw new HttpError(400, 'Estado inválido.');
    where.push('status = ?');
    binds.push(status);
  }
  if (q) {
    // instr() instead of LIKE: D1 rejects LIKE patterns longer than 50 bytes.
    where.push('instr(lower(community_name), lower(?)) > 0');
    binds.push(q);
  }
  const { results } = await env.DB.prepare(
    `SELECT id, community_name, location_text, status, created_at, reviewed_at FROM submissions
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT 500`,
  )
    .bind(...binds)
    .all();
  return json({ submissions: results });
}

async function loadSubmission(ctx: Ctx): Promise<SubmissionRow> {
  const row = await ctx.env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(Number(ctx.params.id)).first<SubmissionRow>();
  if (!row) throw new HttpError(404, 'Solicitud no encontrada.');
  return row;
}

export async function getSubmission(ctx: Ctx): Promise<Response> {
  const submission = await loadSubmission(ctx);
  const { results: history } = await ctx.env.DB.prepare(
    `SELECT a.action, a.previous_state, a.new_state, a.comment, a.created_at, adm.full_name AS admin_name
     FROM audit_logs a LEFT JOIN administrators adm ON adm.id = a.admin_id
     WHERE a.entity_type = 'submission' AND a.entity_id = ? ORDER BY a.created_at, a.id`,
  )
    .bind(submission.id)
    .all();
  const community = await ctx.env.DB.prepare('SELECT id, slug FROM communities WHERE submission_id = ?').bind(submission.id).first();
  return json({ submission, history, community });
}

/** Approving publishes a community profile that carries over the submitter's visibility choices. */
export async function approveSubmission(ctx: Ctx): Promise<Response> {
  const { env } = ctx;
  const admin = ctx.admin!;
  const s = await loadSubmission(ctx);
  if (s.status !== 'pending') return errorResponse(409, 'La solicitud ya fue revisada.');

  const slug = await uniqueSlug(env, s.community_name);
  const hash = await communityDbHash({
    name: s.community_name,
    location_text: s.location_text,
    country: null,
    latitude: s.latitude,
    longitude: s.longitude,
    description: s.description,
    energy_initiative_details: s.energy_initiative_details,
    proposals_tags: null,
    junte_energetico: null,
    website_url: null,
    private_contact_email: s.submitter_email,
    private_comments: s.submitter_comments,
  });
  const showOnMap = s.show_location === 1 && s.latitude !== null ? 1 : 0;

  const [update] = await env.DB.batch([
    // The status guard makes a concurrent double-approval a no-op instead of a duplicate profile.
    env.DB.prepare(
      "UPDATE submissions SET status = 'approved', reviewed_by_admin_id = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'",
    ).bind(admin.id, s.id),
    env.DB.prepare(
      `INSERT INTO communities (submission_id, name, slug, location_text, latitude, longitude, description, energy_initiative_details,
         private_contact_email, private_comments, is_visible, show_name, show_location, show_on_map, show_description,
         show_energy_initiative_details, show_contact_email, sync_source, current_db_hash, created_by_admin_id, updated_by_admin_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'web', ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM communities WHERE submission_id = ?)`,
    ).bind(
      s.id, s.community_name, slug, s.location_text, s.latitude, s.longitude, s.description, s.energy_initiative_details,
      s.submitter_email, s.submitter_comments, s.show_community_name, s.show_location, showOnMap, s.show_description,
      s.show_energy_initiative_details, s.show_submitter_email, hash, admin.id, admin.id, s.id,
    ),
    auditStatement(env, { entity_type: 'submission', entity_id: s.id, action: 'status_change', previous_state: 'pending', new_state: 'approved', admin_id: admin.id }),
  ]);
  if (update.meta.changes === 0) return errorResponse(409, 'La solicitud ya fue revisada.');
  const community = await env.DB.prepare('SELECT id, slug FROM communities WHERE submission_id = ?').bind(s.id).first();
  return json({ ok: true, status: 'approved', community });
}

export async function rejectSubmission(ctx: Ctx): Promise<Response> {
  const { env, request } = ctx;
  const admin = ctx.admin!;
  const s = await loadSubmission(ctx);
  if (s.status !== 'pending') return errorResponse(409, 'La solicitud ya fue revisada.');
  const body = await readJsonObject(request);
  const comment = optionalText(body.comment, 'comment', 2000);
  const [update] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE submissions SET status = 'rejected', rejection_comment = ?, reviewed_by_admin_id = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'",
    ).bind(comment, admin.id, s.id),
    auditStatement(env, { entity_type: 'submission', entity_id: s.id, action: 'status_change', previous_state: 'pending', new_state: 'rejected', comment, admin_id: admin.id }),
  ]);
  if (update.meta.changes === 0) return errorResponse(409, 'La solicitud ya fue revisada.');
  return json({ ok: true, status: 'rejected' });
}
