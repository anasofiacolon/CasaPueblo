import type { ColumnMapping, CommunityField, NormalizedRow, RawSheet, SheetConfig, SkippedRow, SyncConfig, TrackedFields } from './types';

/**
 * Mapping for Casa Pueblo's workbook (`Mapeo Inicial_CP2.xlsx`), checked against the
 * file's real layout:
 *
 *   Puerto Rico     Junte - Transición Energética | Energías Comunitaria | Localización (municipio)
 *                   | Descripción | Propuestas | Proyectos | Website | Contacto | Comentarios
 *                   ...followed by an "Aliados" heading and one ally name per row.
 *   América Latina  same columns without "Junte"; Localización holds the country.
 *   Otros           Aliados | Lugar | Website
 *
 * Headers are matched ignoring case, accents, spacing and punctuation. The first alias
 * of each field is the workbook's own header; the rest are tolerated alternatives.
 */
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  sheets: [
    { sheet: 'Puerto Rico', kind: 'community', keyPrefix: 'pr', region: 'Puerto Rico', defaults: { country: 'Puerto Rico' } },
    // In this tab "Localización" is a country, not a place within one.
    { sheet: 'América Latina', kind: 'community', keyPrefix: 'al', region: 'América Latina', columns: { country: ['Localización', 'País'], location_text: ['Ubicación'] } },
    { sheet: 'Otros', kind: 'ally', keyPrefix: 'aliado', region: null },
  ],
  columns: {
    name: ['Energías Comunitaria', 'Energías Comunitarias', 'Aliados', 'Aliado', 'Nombre', 'Organización', 'Comunidad', 'Name'],
    location_text: ['Localización', 'Lugar', 'Ubicación', 'Municipio', 'Location'],
    country: ['País', 'Country'],
    latitude: ['Latitud', 'Lat', 'Latitude'],
    longitude: ['Longitud', 'Lng', 'Lon', 'Long', 'Longitude'],
    description: ['Descripción', 'Resumen', 'Description'],
    energy_initiative_details: ['Proyectos', 'Proyecto', 'Iniciativa energética', 'Proyecto energético', 'Detalles'],
    proposals_tags: ['Propuestas', 'Propuesta', 'Etiquetas', 'Tags'],
    junte_energetico: ['Junte - Transición Energética', 'Junte Energético', 'Junte'],
    website_url: ['Website', 'Página web', 'Sitio web', 'Enlace', 'Web', 'URL'],
    contact_email: ['Contacto', 'Correo', 'Correo electrónico', 'Email'],
    comments: ['Comentarios', 'Notas', 'Observaciones'],
  },
  // The workbook has no coordinate columns, so map pins are managed in the Admin Portal
  // and a sync never touches them. Add 'latitude' and 'longitude' here if that changes.
  trackedFields: ['name', 'location_text', 'country', 'description', 'energy_initiative_details', 'proposals_tags', 'junte_energetico', 'website_url', 'contact_email', 'comments'],
  allySectionMarkers: ['Aliados', 'Aliado'],
  allyKeyPrefix: 'aliado',
  // The same ally is written both ways in different tabs.
  nameAliases: { UPR: 'University of Puerto Rico' },
};

/** Lowercase, strip accents, collapse everything that is not a letter or digit. */
export function normalizeKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildSourceKey(prefix: string, name: string): string {
  return `${prefix}:${normalizeKey(name)}`;
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

function number(value: unknown): number | null {
  const s = text(value);
  if (s === null) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function yesNo(value: unknown): 0 | 1 | null {
  const s = text(value);
  if (s === null) return null;
  const k = normalizeKey(s);
  if (['1', 'si', 'yes', 'true', 'x', 'verdadero'].includes(k)) return 1;
  if (['0', 'no', 'false', 'falso'].includes(k)) return 0;
  return null;
}

function tags(value: unknown): string | null {
  const s = text(value);
  if (s === null) return null;
  const list = s
    .split(/[;,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
  return list.length ? list.join(';') : null;
}

/**
 * Blank or invalid locations become NULL. Coordinates are kept only as a valid
 * WGS84 pair that is not (0, 0) — the same rule the database enforces.
 */
function coordinatePair(lat: unknown, lng: unknown): { latitude: number | null; longitude: number | null } {
  const latitude = number(lat);
  const longitude = number(lng);
  const valid =
    latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && !(latitude === 0 && longitude === 0);
  return valid ? { latitude, longitude } : { latitude: null, longitude: null };
}

function columnLookup(row: Record<string, unknown>, sheet: SheetConfig, columns: ColumnMapping): (field: CommunityField) => unknown {
  const byHeader = new Map<string, unknown>();
  for (const [header, value] of Object.entries(row)) byHeader.set(normalizeKey(header), value);
  return (field) => {
    // A tab-specific mapping replaces the general one for that field.
    for (const alias of [field, ...(sheet.columns?.[field] ?? columns[field])]) {
      const key = normalizeKey(alias);
      if (byHeader.has(key)) return byHeader.get(key);
    }
    return undefined;
  };
}

function canonicalName(name: string, config: SyncConfig): string {
  const wanted = normalizeKey(name);
  for (const [alias, canonical] of Object.entries(config.nameAliases)) if (normalizeKey(alias) === wanted) return canonical;
  return name;
}

function allyRow(name: string, sheet: SheetConfig, config: SyncConfig, extra: Partial<TrackedFields> = {}): NormalizedRow {
  const canonical = canonicalName(name, config);
  return {
    kind: 'ally', source_key: buildSourceKey(config.allyKeyPrefix, canonical), source_sheet: sheet.sheet, region: null, name: canonical,
    location_text: null, country: null, latitude: null, longitude: null, description: '', energy_initiative_details: '',
    proposals_tags: null, junte_energetico: null, website_url: null, contact_email: null, comments: null, ...extra,
  };
}

export function normalizeRow(raw: Record<string, unknown>, sheet: SheetConfig, config: SyncConfig = DEFAULT_SYNC_CONFIG): NormalizedRow | null {
  const get = columnLookup(raw, sheet, config.columns);
  const rawName = text(get('name'));
  if (rawName === null) return null;
  if (sheet.kind === 'ally') return allyRow(rawName, sheet, config, { location_text: text(get('location_text')), website_url: text(get('website_url')) });
  const name = canonicalName(rawName, config);
  return {
    kind: sheet.kind,
    source_key: buildSourceKey(sheet.keyPrefix, name),
    source_sheet: sheet.sheet,
    region: sheet.region,
    name,
    location_text: text(get('location_text')) ?? sheet.defaults?.location_text ?? null,
    country: text(get('country')) ?? sheet.defaults?.country ?? null,
    ...coordinatePair(get('latitude'), get('longitude')),
    description: text(get('description')) ?? '',
    energy_initiative_details: text(get('energy_initiative_details')) ?? '',
    proposals_tags: tags(get('proposals_tags')),
    junte_energetico: yesNo(get('junte_energetico')),
    website_url: text(get('website_url')),
    contact_email: text(get('contact_email')),
    comments: text(get('comments')),
  };
}

export function normalizeSheets(sheets: RawSheet[], config: SyncConfig = DEFAULT_SYNC_CONFIG): { rows: NormalizedRow[]; skipped: SkippedRow[] } {
  const rows: NormalizedRow[] = [];
  const skipped: SkippedRow[] = [];
  const seen = new Map<string, NormalizedRow>();
  const markers = new Set(config.allySectionMarkers.map(normalizeKey));

  const add = (row: NormalizedRow, sheet: string, index: number) => {
    const existing = seen.get(row.source_key);
    if (!existing) {
      seen.set(row.source_key, row);
      rows.push(row);
    } else if (row.kind === 'ally') {
      // The same ally listed in two tabs is one ally: keep the first and fill in what it lacks.
      existing.location_text ??= row.location_text;
      existing.website_url ??= row.website_url;
    } else {
      skipped.push({ sheet, row: index + 1, reason: 'duplicate_source_key', name: row.name });
    }
  };

  for (const sheet of sheets) {
    const cfg = config.sheets.find((c) => normalizeKey(c.sheet) === normalizeKey(sheet.name));
    if (!cfg) {
      skipped.push({ sheet: sheet.name, row: 0, reason: 'unknown_sheet' });
      continue;
    }
    let inAllySection = false;
    sheet.rows.forEach((raw, i) => {
      const row = normalizeRow(raw, cfg, config);
      if (row) return add(row, sheet.name, i);

      // No name in the name column. Fully blank rows are common and ignored.
      const cells = Object.values(raw).map(text).filter((v): v is string => v !== null);
      if (cells.length === 0) return;
      // A community tab may end with a heading cell ("Aliados") followed by one ally per row.
      if (cfg.kind === 'community' && cells.length === 1) {
        if (markers.has(normalizeKey(cells[0]))) {
          inAllySection = true;
          return;
        }
        if (inAllySection) return add(allyRow(cells[0], cfg, config), sheet.name, i);
      }
      skipped.push({ sheet: sheet.name, row: i + 1, reason: 'missing_name' });
    });
  }
  return { rows, skipped };
}

/** Allies only carry these columns; hashing the rest would make every ally look modified. */
const ALLY_ORDER: (keyof TrackedFields)[] = ['name', 'location_text', 'website_url'];

/**
 * SHA-256 (hex) of the tracked fields in a fixed order. The same function
 * hashes an incoming Excel row and the current DB record, so equal content
 * always produces equal hashes regardless of where it came from. Fields the
 * workbook is not the source for (config.trackedFields) do not take part.
 */
export async function hashTrackedFields(
  fields: TrackedFields,
  kind: 'community' | 'ally' = 'community',
  tracked: CommunityField[] = DEFAULT_SYNC_CONFIG.trackedFields,
): Promise<string> {
  const order = kind === 'ally' ? ALLY_ORDER : tracked;
  const canonical = JSON.stringify(
    order.map((k) => {
      const v = fields[k];
      return [k, v === undefined || v === '' ? null : v];
    }),
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
