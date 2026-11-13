import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SYNC_CONFIG, TemplateFixtureExcelAdapter, decide, hashTrackedFields, normalizeSheets, parseSheetsPayload, reconcileSheetsWithBaselines,
  type Baseline,
} from '../src/lib/excel-sync';
import { createAdmin, db, loginCookie, request } from './helpers';

const baseline = (over: Partial<Baseline>): Baseline => ({
  kind: 'community', id: 1, source_key: 'pr:x', name: 'X', sync_source: 'excel', last_synced_excel_hash: 'A', current_db_hash: 'A', ...over,
});

describe('decide(): three-way hash comparison', () => {
  it('new_from_excel when there is no DB match', () => {
    expect(decide('A', undefined)).toEqual({ decision: 'new_from_excel' });
  });
  it('unchanged when Excel equals the last synced hash, even if the Admin Portal edited the record', () => {
    expect(decide('A', baseline({}))).toEqual({ decision: 'unchanged' });
    expect(decide('A', baseline({ current_db_hash: 'PORTAL' }))).toEqual({ decision: 'unchanged' });
  });
  it('updated_in_excel when only Excel changed', () => {
    expect(decide('B', baseline({}))).toEqual({ decision: 'updated_in_excel' });
  });
  it('conflict_both_modified when Excel and the Admin Portal both changed', () => {
    expect(decide('B', baseline({ current_db_hash: 'PORTAL' }))).toEqual({ decision: 'conflict_both_modified' });
  });
  it('both sides converging on the same values is not a conflict', () => {
    expect(decide('B', baseline({ current_db_hash: 'B' }))).toEqual({ decision: 'unchanged', adopt_baseline: true });
  });
  it('untouched seed rows take the Excel values; edited or web-created rows conflict', () => {
    expect(decide('B', baseline({ sync_source: 'seed', last_synced_excel_hash: null, current_db_hash: null })).decision).toBe('updated_in_excel');
    expect(decide('B', baseline({ sync_source: 'seed', last_synced_excel_hash: null, current_db_hash: 'PORTAL' })).decision).toBe('conflict_both_modified');
    expect(decide('B', baseline({ sync_source: 'web', last_synced_excel_hash: null, current_db_hash: 'WEB' })).decision).toBe('conflict_both_modified');
  });
});

describe('normalizer', () => {
  it('reads the workbook layout: real headers, blank locations as NULL, per-tab location meaning', async () => {
    const { rows, skipped } = normalizeSheets(await new TemplateFixtureExcelAdapter().fetchSheets());
    expect(skipped).toEqual([]);
    const communities = rows.filter((r) => r.kind === 'community');
    expect(communities.map((r) => r.source_key)).toEqual(['pr:comunidad-de-ejemplo', 'pr:comunidad-sin-ubicacion', 'al:iniciativa-de-ejemplo']);
    expect(communities[0]).toMatchObject({
      region: 'Puerto Rico', location_text: 'Adjuntas', country: 'Puerto Rico', proposals_tags: 'Instalación;Comunidades', energy_initiative_details: 'Proyecto Solar',
      junte_energetico: 1, website_url: 'https://example.org', contact_email: 'contacto@example.org', comments: 'Nota interna de ejemplo.',
    });
    expect(communities[1]).toMatchObject({ location_text: null, country: 'Puerto Rico', latitude: null, longitude: null, junte_energetico: 0 });
    // In "América Latina" the Localización column is the country.
    expect(communities[2]).toMatchObject({ region: 'América Latina', country: 'Ecuador', location_text: null, junte_energetico: null });
  });

  it('collects allies from the "Aliados" list inside a community tab and from the Otros tab, merging repeats', async () => {
    const { rows, skipped } = normalizeSheets(await new TemplateFixtureExcelAdapter().fetchSheets());
    expect(skipped).toEqual([]);
    const allies = rows.filter((r) => r.kind === 'ally');
    expect(allies.map((r) => r.source_key)).toEqual(['aliado:aliado-de-ejemplo', 'aliado:universidad-ejemplo', 'aliado:otro-aliado']);
    // Listed bare in the first tab and with details in "Otros": one ally, details kept.
    expect(allies[0]).toMatchObject({ name: 'Aliado de Ejemplo', location_text: 'Puerto Rico', website_url: 'https://aliado.example.org/' });
  });

  it('treats configured spellings of a name as the same organization', () => {
    const { rows } = normalizeSheets([
      { name: 'Puerto Rico', rows: [{ Junte: 'Aliados' }, { Junte: 'University of Puerto Rico' }] },
      { name: 'Otros', rows: [{ Aliados: 'UPR', Lugar: 'Puerto Rico' }] },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'University of Puerto Rico', source_key: 'aliado:university-of-puerto-rico', location_text: 'Puerto Rico' });
  });

  it('a stray single-cell row is reported, not imported, unless it follows the Aliados heading', () => {
    const { rows, skipped } = normalizeSheets([{ name: 'Puerto Rico', rows: [{ Junte: 'Sí' }, { 'Energías Comunitaria': 'Real' }] }]);
    expect(rows.map((r) => r.name)).toEqual(['Real']);
    expect(skipped).toEqual([{ sheet: 'Puerto Rico', row: 1, reason: 'missing_name' }]);
  });

  it('drops invalid, partial and (0, 0) coordinates', () => {
    const sheet = (row: Record<string, unknown>) => normalizeSheets([{ name: 'puerto rico', rows: [{ NOMBRE: 'A', ...row }] }]).rows[0];
    expect(sheet({ Latitud: '18,16', Longitud: '-66.72' })).toMatchObject({ latitude: 18.16, longitude: -66.72 });
    expect(sheet({})).toMatchObject({ latitude: null, longitude: null });
    expect(sheet({ Latitud: 0, Longitud: 0 })).toMatchObject({ latitude: null, longitude: null });
    expect(sheet({ Latitud: 18.1 })).toMatchObject({ latitude: null, longitude: null });
    expect(sheet({ Latitud: 123, Longitud: 5 })).toMatchObject({ latitude: null, longitude: null });
  });

  it('reports duplicate keys, nameless rows and unknown sheets instead of importing them', () => {
    const { rows, skipped } = normalizeSheets([
      { name: 'Puerto Rico', rows: [{ Nombre: 'Casa Pueblo' }, { Nombre: 'CASA  PUEBLO' }, { Descripción: 'sin nombre' }, {}] },
      { name: 'Hoja rara', rows: [{ Nombre: 'X' }] },
    ]);
    expect(rows).toHaveLength(1);
    expect(skipped.map((s) => s.reason).sort()).toEqual(['duplicate_source_key', 'missing_name', 'unknown_sheet']);
  });

  it('hashes are stable, order-independent on input keys, and sensitive to content', async () => {
    const [a] = normalizeSheets([{ name: 'Puerto Rico', rows: [{ Nombre: 'A', Descripción: 'uno', País: 'PR' }] }]).rows;
    const [b] = normalizeSheets([{ name: 'Puerto Rico', rows: [{ País: 'PR', Descripción: ' uno ', Nombre: 'A' }] }]).rows;
    const [c] = normalizeSheets([{ name: 'Puerto Rico', rows: [{ Nombre: 'A', Descripción: 'dos', País: 'PR' }] }]).rows;
    expect(await hashTrackedFields(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashTrackedFields(a)).toBe(await hashTrackedFields(b));
    expect(await hashTrackedFields(a)).not.toBe(await hashTrackedFields(c));
    // Coordinates are not a workbook column, so they do not take part in change tracking.
    expect(await hashTrackedFields({ ...a, latitude: 18.1, longitude: -66.7 })).toBe(await hashTrackedFields(a));
  });

  it('accepts 2D arrays with a header row and the object-of-sheets shape', () => {
    const sheets = parseSheetsPayload({ sheets: { 'Puerto Rico': [['Nombre', 'Ubicación'], ['A', 'Adjuntas'], ['B', null]] } });
    expect(sheets).toEqual([{ name: 'Puerto Rico', rows: [{ Nombre: 'A', Ubicación: 'Adjuntas' }, { Nombre: 'B', Ubicación: null }] }]);
    expect(() => parseSheetsPayload({})).toThrow();
  });

  it('reconcile reports records that disappeared from the workbook without deleting them', async () => {
    const { rows } = normalizeSheets([{ name: 'Puerto Rico', rows: [{ Nombre: 'Sigue' }] }]);
    const result = await reconcileSheetsWithBaselines(rows, [baseline({ id: 7, source_key: 'pr:se-fue', name: 'Se Fue' })]);
    expect(result.summary).toMatchObject({ new_from_excel: 1 });
    expect(result.missing_in_excel.map((b) => b.id)).toEqual([7]);
  });
});

describe('POST /api/sync/excel (one-way Excel -> DB)', () => {
  let cookie: string;
  const row = (over: Record<string, unknown> = {}) => ({ Nombre: 'Comunidad Sync', Ubicación: 'Ciales, Puerto Rico', Descripción: 'Versión 1', Contacto: 'sync@privado.example', Comentarios: 'nota interna', ...over });
  const sync = (rows: Record<string, unknown>[], extra: Record<string, unknown> = {}, auth: { cookie?: string; headers?: Record<string, string> } = { cookie }) =>
    request('/api/sync/excel', { json: { sheets: [{ name: 'Puerto Rico', rows }], ...extra }, ...auth });
  const decisionOf = async (res: Response, key = 'pr:comunidad-sync') => ((await res.json()) as any).rows.find((r: any) => r.source_key === key).decision;
  const record = (key = 'pr:comunidad-sync') => db().prepare('SELECT * FROM communities WHERE source_key = ?').bind(key).first<any>();

  beforeAll(async () => {
    await createAdmin('sync-admin');
    cookie = await loginCookie('sync-admin');
  });

  it('requires an admin session or the sync token', async () => {
    expect((await sync([row()], {}, {})).status).toBe(401);
    expect((await sync([row()], {}, { headers: { authorization: 'Bearer wrong-token-0123456789abcdef' } })).status).toBe(401);
    expect((await request('/api/sync/excel')).status).toBe(401);
    const config = await request('/api/sync/excel', { cookie });
    expect(config.status).toBe(200);
    expect(await config.json()).toMatchObject({ direction: 'excel_to_database', writes_to_excel: false, config: { sheets: DEFAULT_SYNC_CONFIG.sheets } });
  });

  it('dry_run reports decisions without writing anything', async () => {
    const res = await sync([row()], { dry_run: true });
    expect(res.status).toBe(200);
    expect(await decisionOf(res)).toBe('new_from_excel');
    expect(await record()).toBeNull();
  });

  it('new_from_excel: inserts the row hidden, with location and contact private', async () => {
    const res = await sync([row()], {}, { headers: { authorization: 'Bearer test-only-sync-token-0123456789' } });
    expect(await decisionOf(res)).toBe('new_from_excel');
    const c = await record();
    expect(c).toMatchObject({
      name: 'Comunidad Sync', region: 'Puerto Rico', sync_source: 'excel', source_sheet: 'Puerto Rico', is_visible: 0,
      show_location: 0, show_on_map: 0, show_contact_email: 0, private_contact_email: 'sync@privado.example', private_comments: 'nota interna',
    });
    expect(c.last_synced_excel_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.current_db_hash).toBe(c.last_synced_excel_hash);
    expect(await (await request('/api/communities')).text()).not.toContain('Comunidad Sync');
  });

  it('unchanged: re-sending the same workbook changes nothing', async () => {
    const before = await record();
    expect(await decisionOf(await sync([row()]))).toBe('unchanged');
    expect(await record()).toEqual(before);
  });

  it('unchanged: Admin Portal edits survive a sync when Excel did not change', async () => {
    const { id } = await record();
    // This row has no initiative text (the workbook left it blank): it must still be editable.
    const put = await request(`/api/admin/communities/${id}`, { method: 'PUT', json: { is_visible: true, show_location: true, energy_initiative_details: '' }, cookie });
    expect(put.status).toBe(200);
    expect((await request(`/api/admin/communities/${id}`, { method: 'PUT', json: { description: '' }, cookie })).status).toBe(400);
    expect(await decisionOf(await sync([row()]))).toBe('unchanged');
    expect(await record()).toMatchObject({ is_visible: 1, show_location: 1, description: 'Versión 1' });
  });

  it('updated_in_excel: applies the Excel change and keeps the visibility toggles', async () => {
    expect(await decisionOf(await sync([row({ Descripción: 'Versión 2' })]))).toBe('updated_in_excel');
    const c = await record();
    expect(c).toMatchObject({ description: 'Versión 2', is_visible: 1, show_location: 1 });
    expect(c.current_db_hash).toBe(c.last_synced_excel_hash);
  });

  it('conflict_both_modified: logs the conflict once and leaves the Admin Portal edit intact', async () => {
    const { id } = await record();
    expect((await request(`/api/admin/communities/${id}`, { method: 'PUT', json: { description: 'Editado en el portal' }, cookie })).status).toBe(200);

    // Excel unchanged since last sync -> the portal edit is simply preserved.
    expect(await decisionOf(await sync([row({ Descripción: 'Versión 2' })]))).toBe('unchanged');

    // Excel also changes -> conflict.
    for (let i = 0; i < 2; i++) expect(await decisionOf(await sync([row({ Descripción: 'Versión 3' })]))).toBe('conflict_both_modified');
    expect((await record()).description).toBe('Editado en el portal');

    const { results } = await db().prepare("SELECT new_state FROM audit_logs WHERE action = 'excel_conflict' AND entity_id = ?").bind(id).all<{ new_state: string }>();
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0].new_state).description).toBe('Versión 3');
  });

  it('seed rows adopt the workbook on first sync; allies are upserted', async () => {
    const res = await request('/api/sync/excel', {
      json: {
        sheets: [
          { name: 'Puerto Rico', rows: [row({ Descripción: 'Versión 3' }), { Nombre: 'Comunidad Toro Negro', Descripción: 'Texto real del Excel' }] },
          { name: 'Otros', rows: [{ Aliados: 'Aliado Uno', Website: 'https://aliado.example' }] },
        ],
      },
      cookie,
    });
    expect(await decisionOf(res.clone(), 'pr:comunidad-toro-negro')).toBe('updated_in_excel');
    const toro = await record('pr:comunidad-toro-negro');
    // Content comes from Excel; the seeded slug and visibility stay as they were.
    expect(toro).toMatchObject({ description: 'Texto real del Excel', slug: 'comunidad-toro-negro', is_visible: 1, show_location: 0 });
    const allies = ((await (await request('/api/allies')).json()) as any).allies;
    expect(allies).toEqual([{ name: 'Aliado Uno', location_text: null, website_url: 'https://aliado.example' }]);
  });

  it('never touches the map coordinates an administrator set, and that edit alone is not a conflict', async () => {
    const casa = await record('pr:casa-pueblo');
    expect(casa).toMatchObject({ latitude: 18.1627, longitude: -66.7222, show_on_map: 1 });
    const rows = [{ 'Energías Comunitaria': 'Casa Pueblo', Localización: 'Adjuntas', Descripción: 'Texto del Excel' }];
    expect(await decisionOf(await sync(rows), 'pr:casa-pueblo')).toBe('updated_in_excel');
    expect(await record('pr:casa-pueblo')).toMatchObject({ description: 'Texto del Excel', location_text: 'Adjuntas', country: 'Puerto Rico', latitude: 18.1627, longitude: -66.7222, show_on_map: 1 });

    // Moving the pin in the portal is not a content edit of a workbook field...
    expect((await request(`/api/admin/communities/${casa.id}`, { method: 'PUT', json: { latitude: 18.2, longitude: -66.8 }, cookie })).status).toBe(200);
    // ...so a later Excel change still applies cleanly and the new pin stays.
    rows[0].Descripción = 'Texto del Excel v2';
    expect(await decisionOf(await sync(rows), 'pr:casa-pueblo')).toBe('updated_in_excel');
    expect(await record('pr:casa-pueblo')).toMatchObject({ description: 'Texto del Excel v2', latitude: 18.2, longitude: -66.8 });
  });

  it('toggling visibility on a seeded community does not block its first sync', async () => {
    const before = await record('al:fundacion-kara-solar');
    expect((await request(`/api/admin/communities/${before.id}`, { method: 'PUT', json: { is_visible: false, show_location: true }, cookie })).status).toBe(200);
    expect((await record('al:fundacion-kara-solar')).current_db_hash).toBeNull();
    const res = await request('/api/sync/excel', { json: { sheets: [{ name: 'América Latina', rows: [{ 'Energías Comunitaria': 'Fundación Kara Solar', Localización: 'Ecuador', Descripción: 'Del Excel' }] }] }, cookie });
    expect(await decisionOf(res, 'al:fundacion-kara-solar')).toBe('updated_in_excel');
    expect(await record('al:fundacion-kara-solar')).toMatchObject({ description: 'Del Excel', country: 'Ecuador', is_visible: 0, show_location: 1 });
  });

  it('records each import in audit_logs and rejects malformed payloads', async () => {
    const imports = await db().prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'excel_import'").first<{ n: number }>();
    expect(imports!.n).toBeGreaterThan(0);
    expect((await request('/api/sync/excel', { json: { nope: true }, cookie })).status).toBe(400);
    expect((await request('/api/sync/excel', { json: { sheets: [{ rows: [] }] }, cookie })).status).toBe(400);
  });
});
