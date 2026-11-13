import type { ColumnMapping, CommunityField, NormalizedRow, RawSheet, SheetConfig, SkippedRow, SyncConfig, TrackedFields } from './types';

/**
 * Default mapping for Casa Pueblo's workbook (`Mapeo Inicial_CP2.xlsx`).
 * The header aliases are deliberately generous: adjust them here (or pass a
 * custom SyncConfig) once the exact column names are confirmed with the client.
 */
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  sheets: [
    { sheet: 'Puerto Rico', kind: 'community', keyPrefix: 'pr', region: 'Puerto Rico' },
    { sheet: 'América Latina', kind: 'community', keyPrefix: 'al', region: 'América Latina' },
    { sheet: 'Otros', kind: 'ally', keyPrefix: 'otros', region: null },
  ],
  columns: {
    name: ['Nombre', 'Organización', 'Comunidad', 'Iniciativa', 'Name'],
    location_text: ['Ubicación', 'Localización', 'Municipio', 'Lugar', 'Location'],
    country: ['País', 'Country'],
    latitude: ['Latitud', 'Lat', 'Latitude'],
    longitude: ['Longitud', 'Lng', 'Lon', 'Long', 'Longitude'],
    description: ['Descripción', 'Resumen', 'Description'],
    energy_initiative_details: ['Iniciativa energética', 'Proyecto energético', 'Proyecto', 'Detalles'],
    proposals_tags: ['Propuestas', 'Propuesta', 'Etiquetas', 'Tags'],
    junte_energetico: ['Junte Energético', 'Junte'],
    website_url: ['Página web', 'Sitio web', 'Enlace', 'Web', 'URL', 'Website'],
    contact_email: ['Contacto', 'Correo', 'Correo electrónico', 'Email'],
    comments: ['Comentarios', 'Notas', 'Observaciones'],
  },
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

function columnLookup(row: Record<string, unknown>, columns: ColumnMapping): (field: CommunityField) => unknown {
  const byHeader = new Map<string, unknown>();
  for (const [header, value] of Object.entries(row)) byHeader.set(normalizeKey(header), value);
  return (field) => {
    for (const alias of [field, ...columns[field]]) {
      const key = normalizeKey(alias);
      if (byHeader.has(key)) return byHeader.get(key);
    }
    return undefined;
  };
}

export function normalizeRow(raw: Record<string, unknown>, sheet: SheetConfig, columns: ColumnMapping): NormalizedRow | null {
  const get = columnLookup(raw, columns);
  const name = text(get('name'));
  if (name === null) return null;
  return {
    kind: sheet.kind,
    source_key: buildSourceKey(sheet.keyPrefix, name),
    source_sheet: sheet.sheet,
    region: sheet.region,
    name,
    location_text: text(get('location_text')),
    country: text(get('country')),
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
  const seen = new Set<string>();
  for (const sheet of sheets) {
    const cfg = config.sheets.find((c) => normalizeKey(c.sheet) === normalizeKey(sheet.name));
    if (!cfg) {
      skipped.push({ sheet: sheet.name, row: 0, reason: 'unknown_sheet' });
      continue;
    }
    sheet.rows.forEach((raw, i) => {
      const row = normalizeRow(raw, cfg, config.columns);
      if (!row) {
        // Fully blank rows are common in spreadsheets; only report rows that carry data.
        if (Object.values(raw).some((v) => text(v) !== null)) skipped.push({ sheet: sheet.name, row: i + 1, reason: 'missing_name' });
        return;
      }
      if (seen.has(row.source_key)) {
        skipped.push({ sheet: sheet.name, row: i + 1, reason: 'duplicate_source_key', name: row.name });
        return;
      }
      seen.add(row.source_key);
      rows.push(row);
    });
  }
  return { rows, skipped };
}

const TRACKED_ORDER: (keyof TrackedFields)[] = [
  'name',
  'location_text',
  'country',
  'latitude',
  'longitude',
  'description',
  'energy_initiative_details',
  'proposals_tags',
  'junte_energetico',
  'website_url',
  'contact_email',
  'comments',
];

/** Allies only carry these columns; hashing the rest would make every ally look modified. */
const ALLY_ORDER: (keyof TrackedFields)[] = ['name', 'location_text', 'website_url'];

/**
 * SHA-256 (hex) of the tracked fields in a fixed order. The same function
 * hashes an incoming Excel row and the current DB record, so equal content
 * always produces equal hashes regardless of where it came from.
 */
export async function hashTrackedFields(fields: TrackedFields, kind: 'community' | 'ally' = 'community'): Promise<string> {
  const order = kind === 'ally' ? ALLY_ORDER : TRACKED_ORDER;
  const canonical = JSON.stringify(
    order.map((k) => {
      const v = fields[k];
      return [k, v === undefined || v === '' ? null : v];
    }),
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
