import { auditStatement } from '../lib/audit';
import { communityDbHash, publicCommunity, uniqueSlug, type CommunityRow } from '../lib/communities';
import { HttpError, coordinates, flag, isEmail, json, optionalText, readJsonObject, requiredText } from '../lib/http';
import type { Ctx } from '../types';

const PUBLIC_FILTER = 'is_visible = 1 AND deleted_at IS NULL';

// ---------- public ----------
export async function listPublicCommunities({ env }: Ctx): Promise<Response> {
  const { results } = await env.DB.prepare(`SELECT * FROM communities WHERE ${PUBLIC_FILTER} ORDER BY name COLLATE NOCASE`).all<CommunityRow>();
  return json({ communities: results.map(publicCommunity) });
}

export async function getPublicCommunity({ env, params }: Ctx): Promise<Response> {
  // Communities with a hidden name are only reachable through their neutral id-based slug.
  let row = await env.DB.prepare(`SELECT * FROM communities WHERE slug = ? AND show_name = 1 AND ${PUBLIC_FILTER}`).bind(params.slug).first<CommunityRow>();
  const neutral = /^comunidad-(\d+)$/.exec(params.slug);
  if (!row && neutral) {
    row = await env.DB.prepare(`SELECT * FROM communities WHERE id = ? AND show_name = 0 AND ${PUBLIC_FILTER}`).bind(Number(neutral[1])).first<CommunityRow>();
  }
  if (!row) throw new HttpError(404, 'Comunidad no encontrada.');
  return json({ community: publicCommunity(row) });
}

export async function listAllies({ env }: Ctx): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT name, location_text, website_url FROM allies ORDER BY name COLLATE NOCASE').all();
  return json({ allies: results });
}

// ---------- admin ----------
export async function listAdminCommunities({ env }: Ctx): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT * FROM communities WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE').all<CommunityRow>();
  return json({ communities: results });
}

async function loadCommunity(ctx: Ctx): Promise<CommunityRow> {
  const row = await ctx.env.DB.prepare('SELECT * FROM communities WHERE id = ? AND deleted_at IS NULL').bind(Number(ctx.params.id)).first<CommunityRow>();
  if (!row) throw new HttpError(404, 'Comunidad no encontrada.');
  return row;
}

export async function getAdminCommunity(ctx: Ctx): Promise<Response> {
  return json({ community: await loadCommunity(ctx) });
}

type Editable = Pick<
  CommunityRow,
  | 'name' | 'region' | 'location_text' | 'country' | 'latitude' | 'longitude' | 'description' | 'energy_initiative_details'
  | 'proposals_tags' | 'junte_energetico' | 'website_url' | 'private_contact_email' | 'private_comments'
  | 'is_visible' | 'show_name' | 'show_location' | 'show_on_map' | 'show_description' | 'show_energy_initiative_details'
  | 'show_website_url' | 'show_contact_email'
>;

// Schema defaults: location, map pin and contact stay hidden unless explicitly enabled.
const DEFAULTS: Editable = {
  name: '', region: null, location_text: null, country: null, latitude: null, longitude: null, description: '',
  energy_initiative_details: '', proposals_tags: null, junte_energetico: null, website_url: null, private_contact_email: null,
  private_comments: null, is_visible: 1, show_name: 1, show_location: 0, show_on_map: 0, show_description: 1,
  show_energy_initiative_details: 1, show_website_url: 1, show_contact_email: 0,
};

/** Validates the fields present in `b` and overlays them on `base` (partial update semantics). */
function mergeEditable(base: Editable, b: Record<string, unknown>, isNew = false): Editable {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  const next = { ...base };
  if (has('name')) next.name = requiredText(b.name, 'name', 200);
  // Rows imported from Excel may legitimately lack these texts. They are required for new
  // profiles, and an existing text cannot be blanked, but an already-blank one may stay blank.
  for (const k of ['description', 'energy_initiative_details'] as const) {
    if (has(k)) next[k] = base[k] === '' && !isNew ? (optionalText(b[k], k) ?? '') : requiredText(b[k], k);
  }
  if (has('region')) next.region = optionalText(b.region, 'region', 100);
  if (has('location_text')) next.location_text = optionalText(b.location_text, 'location_text', 300);
  if (has('country')) next.country = optionalText(b.country, 'country', 100);
  if (has('proposals_tags')) next.proposals_tags = optionalText(b.proposals_tags, 'proposals_tags', 500);
  if (has('website_url')) {
    next.website_url = optionalText(b.website_url, 'website_url', 500);
    if (next.website_url && !/^https?:\/\//i.test(next.website_url)) throw new HttpError(400, 'El enlace debe comenzar con http:// o https://.');
  }
  if (has('private_contact_email')) {
    next.private_contact_email = optionalText(b.private_contact_email, 'private_contact_email', 254);
    if (next.private_contact_email && !isEmail(next.private_contact_email)) throw new HttpError(400, 'El correo de contacto no es válido.');
  }
  if (has('private_comments')) next.private_comments = optionalText(b.private_comments, 'private_comments');
  if (has('junte_energetico')) next.junte_energetico = b.junte_energetico === null ? null : flag(b.junte_energetico, 'junte_energetico', 0);
  if (has('latitude') || has('longitude')) {
    Object.assign(next, coordinates(has('latitude') ? b.latitude : base.latitude, has('longitude') ? b.longitude : base.longitude));
  }
  for (const k of ['is_visible', 'show_name', 'show_location', 'show_on_map', 'show_description', 'show_energy_initiative_details', 'show_website_url', 'show_contact_email'] as const) {
    if (has(k)) next[k] = flag(b[k], k, base[k]);
  }
  if (!next.name) throw new HttpError(400, 'El campo name es requerido.');
  if (isNew && !next.description) throw new HttpError(400, 'El campo description es requerido.');
  if (isNew && !next.energy_initiative_details) throw new HttpError(400, 'El campo energy_initiative_details es requerido.');
  return next;
}

const COLUMNS: (keyof Editable)[] = [
  'name', 'region', 'location_text', 'country', 'latitude', 'longitude', 'description', 'energy_initiative_details',
  'proposals_tags', 'junte_energetico', 'website_url', 'private_contact_email', 'private_comments',
  'is_visible', 'show_name', 'show_location', 'show_on_map', 'show_description', 'show_energy_initiative_details',
  'show_website_url', 'show_contact_email',
];

export async function createCommunity(ctx: Ctx): Promise<Response> {
  const { env, request } = ctx;
  const admin = ctx.admin!;
  const c = mergeEditable(DEFAULTS, await readJsonObject(request), true);
  const slug = await uniqueSlug(env, c.name);
  const hash = await communityDbHash(c);
  const result = await env.DB.prepare(
    `INSERT INTO communities (${COLUMNS.join(', ')}, slug, sync_source, current_db_hash, created_by_admin_id, updated_by_admin_id)
     VALUES (${COLUMNS.map(() => '?').join(', ')}, ?, 'web', ?, ?, ?)`,
  )
    .bind(...COLUMNS.map((k) => c[k]), slug, hash, admin.id, admin.id)
    .run();
  const id = result.meta.last_row_id;
  await auditStatement(env, { entity_type: 'community', entity_id: id, action: 'create', new_state: c, admin_id: admin.id }).run();
  return json({ community: await env.DB.prepare('SELECT * FROM communities WHERE id = ?').bind(id).first() }, 201);
}

export async function updateCommunity(ctx: Ctx): Promise<Response> {
  const { env, request } = ctx;
  const admin = ctx.admin!;
  const current = await loadCommunity(ctx);
  const c = mergeEditable(current, await readJsonObject(request));
  // current_db_hash is how the next Excel sync knows the Admin Portal changed this record.
  const hash = await communityDbHash(c);
  const before = Object.fromEntries(COLUMNS.filter((k) => current[k] !== c[k]).map((k) => [k, current[k]]));
  const after = Object.fromEntries(COLUMNS.filter((k) => current[k] !== c[k]).map((k) => [k, c[k]]));
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE communities SET ${COLUMNS.map((k) => `${k} = ?`).join(', ')}, current_db_hash = ?, updated_by_admin_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).bind(...COLUMNS.map((k) => c[k]), hash, admin.id, current.id),
    auditStatement(env, { entity_type: 'community', entity_id: current.id, action: 'update', previous_state: before, new_state: after, admin_id: admin.id }),
  ]);
  return json({ community: await env.DB.prepare('SELECT * FROM communities WHERE id = ?').bind(current.id).first() });
}

/** Soft delete: the record leaves every listing but stays in the database for the audit trail. */
export async function deleteCommunity(ctx: Ctx): Promise<Response> {
  const { env } = ctx;
  const admin = ctx.admin!;
  const current = await loadCommunity(ctx);
  await env.DB.batch([
    env.DB.prepare('UPDATE communities SET deleted_at = CURRENT_TIMESTAMP, is_visible = 0, updated_by_admin_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(admin.id, current.id),
    auditStatement(env, { entity_type: 'community', entity_id: current.id, action: 'delete', previous_state: { name: current.name }, admin_id: admin.id }),
  ]);
  return json({ ok: true });
}
