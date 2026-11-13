// Generic, zero-dependency one-way Excel -> database sync boilerplate.
// Nothing in this folder ever writes to the client's workbook.

/** A worksheet as delivered by any adapter: one object per row, keyed by column header. */
export interface RawSheet {
  name: string;
  rows: Record<string, unknown>[];
}

export type SheetKind = 'community' | 'ally';

/** How one workbook tab maps onto our tables. */
export interface SheetConfig {
  /** Tab name in the workbook (matched ignoring case and accents). */
  sheet: string;
  kind: SheetKind;
  /** Prefix of the deterministic source_key, e.g. 'pr' -> 'pr:casa-pueblo'. */
  keyPrefix: string;
  /** Stored in communities.region; null for allies. */
  region: string | null;
}

export type CommunityField =
  | 'name'
  | 'location_text'
  | 'country'
  | 'latitude'
  | 'longitude'
  | 'description'
  | 'energy_initiative_details'
  | 'proposals_tags'
  | 'junte_energetico'
  | 'website_url'
  | 'contact_email'
  | 'comments';

/** Canonical field -> accepted column headers (matched ignoring case, accents and punctuation). */
export type ColumnMapping = Record<CommunityField, string[]>;

export interface SyncConfig {
  sheets: SheetConfig[];
  columns: ColumnMapping;
}

/** The fields that take part in change tracking, for both an Excel row and a DB row. */
export interface TrackedFields {
  name: string;
  location_text: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  description: string;
  energy_initiative_details: string;
  proposals_tags: string | null;
  junte_energetico: 0 | 1 | null;
  website_url: string | null;
  contact_email: string | null;
  comments: string | null;
}

export interface NormalizedRow extends TrackedFields {
  kind: SheetKind;
  source_key: string;
  source_sheet: string;
  region: string | null;
}

export interface SkippedRow {
  sheet: string;
  /** 1-based index of the data row inside the sheet. */
  row: number;
  reason: 'missing_name' | 'duplicate_source_key' | 'unknown_sheet';
  name?: string;
}

/** What our database remembers about a previously seen row. */
export interface Baseline {
  kind: SheetKind;
  id: number;
  source_key: string | null;
  name: string;
  sync_source: 'web' | 'excel' | 'seed';
  last_synced_excel_hash: string | null;
  current_db_hash: string | null;
}

export type SyncDecision = 'new_from_excel' | 'unchanged' | 'updated_in_excel' | 'conflict_both_modified';

export interface RowOutcome {
  decision: SyncDecision;
  row: NormalizedRow;
  incoming_excel_hash: string;
  /** The matched DB record (absent for new_from_excel). */
  baseline?: Baseline;
  /** True when the DB already holds these values and only the stored baseline hash needs refreshing. */
  adopt_baseline?: boolean;
}

export interface ReconcileResult {
  outcomes: RowOutcome[];
  /** DB records that came from Excel but are no longer present in the workbook. Never deleted automatically. */
  missing_in_excel: Baseline[];
  summary: Record<SyncDecision, number>;
}

/** A read-only source of workbook data. Implementations must never modify the workbook. */
export interface ExcelSourceAdapter {
  readonly id: string;
  fetchSheets(): Promise<RawSheet[]>;
}
