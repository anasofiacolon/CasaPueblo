import { auditStatement } from '../lib/audit';
import { currentAdmin } from '../lib/auth';
import { uniqueSlug } from '../lib/communities';
import {
  DEFAULT_SYNC_CONFIG,
  HostedJsonFeedAdapter,
  PushPayloadExcelAdapter,
  normalizeSheets,
  reconcileSheetsWithBaselines,
  type Baseline,
  type ExcelSourceAdapter,
  type NormalizedRow,
  type RowOutcome,
} from '../lib/excel-sync';
import { HttpError, json, readJsonObject } from '../lib/http';
import type { AdminSession, Ctx, Env } from '../types';

/** Admin session cookie, or the shared SYNC_TOKEN as a bearer token (for Power Automate / scripts). */
async function authorize({ request, env }: Ctx): Promise<AdminSession | null> {
  const admin = await currentAdmin(request, env);
  if (admin) return admin;
  const bearer = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (env.SYNC_TOKEN && env.SYNC_TOKEN.length >= 16 && bearer) {
    const enc = new TextEncoder();
    // Compare digests so the comparison time does not depend on the token contents.
    const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(bearer)), crypto.subtle.digest('SHA-256', enc.encode(env.SYNC_TOKEN))]);
    const x = new Uint8Array(a);
    const y = new Uint8Array(b);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    if (diff === 0) return null;
  }
  throw new HttpError(401, 'No autenticado.');
}

/** GET /api/sync/excel — describes the expected workbook layout and the last import. */
export async function syncConfig(ctx: Ctx): Promise<Response> {
  await authorize(ctx);
  const last = await ctx.env.DB.prepare("SELECT new_state, created_at FROM audit_logs WHERE entity_type = 'excel_sync' AND action = 'excel_import' ORDER BY id DESC LIMIT 1").first<{ new_state: string; created_at: string }>();
  return json({
    direction: 'excel_to_database',
    writes_to_excel: false,
    sources: { push: true, feed: Boolean(ctx.env.EXCEL_FEED_URL), graph: false },
    config: DEFAULT_SYNC_CONFIG,
    payload_example: { dry_run: true, sheets: [{ name: 'Puerto Rico', rows: [{ Nombre: '…', Ubicación: '…', Descripción: '…' }] }] },
    last_import: last ? { at: last.created_at, summary: JSON.parse(last.new_state) } : null,
  });
}

async function loadBaselines(env: Env): Promise<Baseline[]> {
  const [communities, allies] = await env.DB.batch<Omit<Baseline, 'kind'>>([
    env.DB.prepare('SELECT id, source_key, name, sync_source, last_synced_excel_hash, current_db_hash FROM communities WHERE deleted_at IS NULL'),
    // Allies are only ever written by the sync, so the DB side always equals the last synced hash.
    env.DB.prepare("SELECT id, source_key, name, 'excel' AS sync_source, last_synced_excel_hash, last_synced_excel_hash AS current_db_hash FROM allies"),
  ]);
  return [...communities.results.map((b) => ({ ...b, kind: 'community' as const })), ...allies.results.map((b) => ({ ...b, kind: 'ally' as const }))];
}

const COMMUNITY_SET = `name = ?, region = ?, location_text = ?, country = ?, latitude = ?, longitude = ?, description = ?,
  energy_initiative_details = ?, proposals_tags = ?, junte_energetico = ?, website_url = ?, private_contact_email = ?, private_comments = ?`;
const communityValues = (r: NormalizedRow) => [
  r.name, r.region, r.location_text, r.country, r.latitude, r.longitude, r.description, r.energy_initiative_details,
  r.proposals_tags, r.junte_energetico, r.website_url, r.contact_email, r.comments,
];

async function statementsFor(env: Env, o: RowOutcome, adminId: number | null, slugs: Set<string>): Promise<D1PreparedStatement[]> {
  const { row: r, incoming_excel_hash: hash, baseline } = o;

  if (r.kind === 'ally') {
    if (o.decision === 'unchanged') return [];
    return [
      env.DB.prepare(
        `INSERT INTO allies (source_key, name, location_text, website_url, last_synced_excel_hash) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_key) DO UPDATE SET name = excluded.name, location_text = excluded.location_text, website_url = excluded.website_url,
           last_synced_excel_hash = excluded.last_synced_excel_hash, updated_at = CURRENT_TIMESTAMP`,
      ).bind(r.source_key, r.name, r.location_text, r.website_url, hash),
    ];
  }

  switch (o.decision) {
    case 'new_from_excel':
      // New rows arrive hidden (is_visible = 0, location/contact toggles at their hidden defaults):
      // the workbook is an internal document, so an administrator decides what gets published.
      return [
        env.DB.prepare(
          `INSERT INTO communities (source_key, slug, name, region, location_text, country, latitude, longitude, description, energy_initiative_details,
             proposals_tags, junte_energetico, website_url, private_contact_email, private_comments,
             is_visible, sync_source, source_sheet, last_synced_excel_hash, current_db_hash, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'excel', ?, ?, ?, CURRENT_TIMESTAMP)`,
        ).bind(r.source_key, await uniqueSlug(env, r.name, slugs), ...communityValues(r), r.source_sheet, hash, hash),
      ];
    case 'updated_in_excel':
      // Only content columns change. Visibility toggles belong to the Admin Portal and are never touched by a sync.
      return [
        env.DB.prepare(
          `UPDATE communities SET ${COMMUNITY_SET}, source_key = ?, source_sheet = ?, last_synced_excel_hash = ?, current_db_hash = ?,
             last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        ).bind(...communityValues(r), r.source_key, r.source_sheet, hash, hash, baseline!.id),
        auditStatement(env, { entity_type: 'community', entity_id: baseline!.id, action: 'update', comment: 'excel_sync', new_state: { source_key: r.source_key, incoming_excel_hash: hash }, admin_id: adminId }),
      ];
    case 'unchanged':
      return o.adopt_baseline
        ? [env.DB.prepare('UPDATE communities SET source_key = COALESCE(source_key, ?), last_synced_excel_hash = ?, last_synced_at = CURRENT_TIMESTAMP WHERE id = ?').bind(r.source_key, hash, baseline!.id)]
        : [];
    case 'conflict_both_modified':
      // The DB record is left exactly as the Admin Portal saved it. Each distinct incoming version is logged once.
      return [
        env.DB.prepare(
          `INSERT INTO audit_logs (entity_type, entity_id, action, previous_state, new_state, comment, admin_id)
           SELECT 'excel_sync', ?1, 'excel_conflict', ?2, ?3, ?4, ?5
           WHERE NOT EXISTS (SELECT 1 FROM audit_logs WHERE entity_type = 'excel_sync' AND action = 'excel_conflict' AND entity_id = ?1 AND comment = ?4)`,
        ).bind(
          baseline!.id,
          JSON.stringify({ last_synced_excel_hash: baseline!.last_synced_excel_hash, current_db_hash: baseline!.current_db_hash }),
          JSON.stringify(r),
          `incoming_excel_hash=${hash}`,
          adminId,
        ),
      ];
  }
}

/**
 * POST /api/sync/excel — one-way reconciliation, Excel -> DB.
 * Body: { sheets: [...], dry_run?: boolean }  (pushed rows), or { source: "feed", dry_run?: boolean }.
 * Nothing here can write to the workbook: adapters only read.
 */
export async function syncExcel(ctx: Ctx): Promise<Response> {
  const { env, request, url } = ctx;
  const admin = await authorize(ctx);
  const body = await readJsonObject(request);
  const dryRun = body.dry_run === true || url.searchParams.get('dry_run') === '1';

  let adapter: ExcelSourceAdapter;
  if (body.source === 'feed') {
    if (!env.EXCEL_FEED_URL) throw new HttpError(400, 'EXCEL_FEED_URL no está configurado.');
    adapter = new HostedJsonFeedAdapter(env.EXCEL_FEED_URL);
  } else {
    adapter = new PushPayloadExcelAdapter(body);
  }

  let sheets;
  try {
    sheets = await adapter.fetchSheets();
  } catch (err) {
    throw new HttpError(body.source === 'feed' ? 502 : 400, (err as Error).message);
  }

  const { rows, skipped } = normalizeSheets(sheets, DEFAULT_SYNC_CONFIG);
  const result = await reconcileSheetsWithBaselines(rows, await loadBaselines(env));

  const report = {
    dry_run: dryRun,
    source: adapter.id,
    summary: result.summary,
    skipped,
    missing_in_excel: result.missing_in_excel.map((b) => ({ kind: b.kind, id: b.id, source_key: b.source_key, name: b.name })),
    rows: result.outcomes.map((o) => ({ kind: o.row.kind, sheet: o.row.source_sheet, source_key: o.row.source_key, name: o.row.name, decision: o.decision })),
  };
  if (dryRun) return json(report);

  const slugs = new Set<string>();
  const statements: D1PreparedStatement[] = [];
  for (const o of result.outcomes) statements.push(...(await statementsFor(env, o, admin?.id ?? null, slugs)));
  statements.push(
    auditStatement(env, { entity_type: 'excel_sync', action: 'excel_import', new_state: { source: adapter.id, summary: result.summary, skipped: skipped.length }, admin_id: admin?.id ?? null }),
  );
  // One batch = one transaction: a failing row rolls the whole import back.
  await env.DB.batch(statements);
  return json(report);
}
