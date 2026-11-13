import type { ExcelSourceAdapter, RawSheet } from './types';

/** Turns a 2D array (first row = headers) into one object per row. */
export function tableToRows(values: unknown[][]): Record<string, unknown>[] {
  const [header, ...body] = values;
  if (!header) return [];
  const names = header.map((h) => (h === null || h === undefined ? '' : String(h).trim()));
  return body.map((cells) => {
    const row: Record<string, unknown> = {};
    names.forEach((name, i) => {
      if (name !== '') row[name] = cells[i] ?? null;
    });
    return row;
  });
}

function rowsFrom(value: unknown, sheet: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`La hoja "${sheet}" debe traer una lista de filas.`);
  if (value.length === 0) return [];
  if (value.every((r) => Array.isArray(r))) return tableToRows(value as unknown[][]);
  if (value.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r))) return value as Record<string, unknown>[];
  throw new Error(`La hoja "${sheet}" mezcla formatos de fila.`);
}

/**
 * Accepts the shapes a push source naturally produces:
 *   { "sheets": [ { "name": "Puerto Rico", "rows": [ {..}, .. ] } ] }
 *   { "sheets": { "Puerto Rico": [ {..}, .. ] } }
 * Rows may be objects keyed by header, or 2D arrays whose first row is the header.
 */
export function parseSheetsPayload(payload: unknown): RawSheet[] {
  const sheets = (payload as { sheets?: unknown } | null)?.sheets;
  if (Array.isArray(sheets)) {
    return sheets.map((s, i) => {
      const sheet = s as { name?: unknown; rows?: unknown; values?: unknown };
      if (typeof sheet?.name !== 'string' || sheet.name.trim() === '') throw new Error(`La hoja #${i + 1} no tiene nombre.`);
      return { name: sheet.name, rows: rowsFrom(sheet.rows ?? sheet.values, sheet.name) };
    });
  }
  if (sheets && typeof sheets === 'object') {
    return Object.entries(sheets as Record<string, unknown>).map(([name, rows]) => ({ name, rows: rowsFrom(rows, name) }));
  }
  throw new Error('El cuerpo debe incluir "sheets".');
}

/** Data pushed to us by Power Query / Power Automate / a browser upload. */
export class PushPayloadExcelAdapter implements ExcelSourceAdapter {
  readonly id = 'push';
  constructor(private payload: unknown) {}
  async fetchSheets(): Promise<RawSheet[]> {
    return parseSheetsPayload(this.payload);
  }
}

/** A JSON document, in the same shape as a push payload, hosted at a URL we only GET. */
export class HostedJsonFeedAdapter implements ExcelSourceAdapter {
  readonly id = 'feed';
  constructor(private url: string, private headers: Record<string, string> = {}, private fetcher: typeof fetch = fetch) {}
  async fetchSheets(): Promise<RawSheet[]> {
    const res = await this.fetcher(this.url, { method: 'GET', headers: { accept: 'application/json', ...this.headers } });
    if (!res.ok) throw new Error(`El feed respondió ${res.status}.`);
    return parseSheetsPayload(await res.json());
  }
}

export interface GraphWorkbookOptions {
  /** OAuth token with Files.Read (read-only) scope. */
  getAccessToken: () => Promise<string>;
  driveId: string;
  itemId: string;
  sheetNames: string[];
  fetcher?: typeof fetch;
}

/**
 * Pulls worksheet values from OneDrive / SharePoint through Microsoft Graph.
 * It only ever issues GET requests against `usedRange`, so it cannot change
 * the workbook even if the token were granted broader permissions.
 * Not wired to a route yet: it needs the tenant/app registration details from
 * Casa Pueblo.
 */
export class MicrosoftGraphReadOnlyWorkbookAdapter implements ExcelSourceAdapter {
  readonly id = 'graph';
  constructor(private options: GraphWorkbookOptions) {}
  async fetchSheets(): Promise<RawSheet[]> {
    const { getAccessToken, driveId, itemId, sheetNames, fetcher = fetch } = this.options;
    const token = await getAccessToken();
    const sheets: RawSheet[] = [];
    for (const name of sheetNames) {
      const sheet = encodeURIComponent(name.replace(/'/g, "''"));
      const url = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/workbook/worksheets('${sheet}')/usedRange(valuesOnly=true)?$select=values`;
      const res = await fetcher(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
      if (!res.ok) throw new Error(`Microsoft Graph respondió ${res.status} para la hoja "${name}".`);
      const body = (await res.json()) as { values?: unknown[][] };
      sheets.push({ name, rows: tableToRows(body.values ?? []) });
    }
    return sheets;
  }
}

/** Placeholder workbook used in tests and demos until the real column layout is confirmed. */
export const TEMPLATE_FIXTURE: RawSheet[] = [
  {
    name: 'Puerto Rico',
    rows: [
      { Nombre: 'Comunidad de Ejemplo', Ubicación: 'Municipio, Puerto Rico', País: 'Puerto Rico', Descripción: 'Descripción de ejemplo.', Propuestas: 'Solar; Microredes', 'Junte Energético': 'Sí', 'Página web': 'https://example.org', Contacto: 'contacto@example.org', Comentarios: 'Nota interna de ejemplo.' },
      { Nombre: 'Comunidad sin Ubicación', Ubicación: '', Descripción: 'La ubicación en blanco se guarda como NULL.' },
    ],
  },
  { name: 'América Latina', rows: [{ Nombre: 'Iniciativa de Ejemplo', País: 'Ecuador', Descripción: 'Descripción de ejemplo.', Propuestas: 'Solar' }] },
  { name: 'Otros', rows: [{ Nombre: 'Aliado de Ejemplo', Ubicación: 'San Juan, Puerto Rico', 'Página web': 'https://example.org' }] },
];

export class TemplateFixtureExcelAdapter implements ExcelSourceAdapter {
  readonly id = 'fixture';
  constructor(private sheets: RawSheet[] = TEMPLATE_FIXTURE) {}
  async fetchSheets(): Promise<RawSheet[]> {
    return structuredClone(this.sheets);
  }
}
