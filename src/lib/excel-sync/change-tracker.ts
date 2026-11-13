import { hashTrackedFields, normalizeKey } from './normalizer';
import type { Baseline, NormalizedRow, ReconcileResult, RowOutcome, SyncDecision } from './types';

/**
 * Three-way comparison for one row:
 *
 *   incoming == last_synced                      -> unchanged (Admin Portal edits are preserved)
 *   incoming != last_synced, db == last_synced   -> updated_in_excel (safe to apply)
 *   incoming != last_synced, db != last_synced   -> conflict_both_modified (logged, DB untouched)
 *   no DB match                                  -> new_from_excel
 *
 * Two extra cases follow from the same rule:
 *   - Both sides changed to the same values (incoming == db): nothing to apply,
 *     only the stored baseline hash is refreshed (`adopt_baseline`).
 *   - A record with no baseline yet: seed rows that nobody edited take the
 *     Excel values; anything else differing from Excel is a conflict.
 */
export function decide(incomingHash: string, baseline: Baseline | undefined): { decision: SyncDecision; adopt_baseline?: boolean } {
  if (!baseline) return { decision: 'new_from_excel' };
  const { last_synced_excel_hash: last, current_db_hash: db } = baseline;
  if (incomingHash === last) return { decision: 'unchanged' };
  if (db !== null && incomingHash === db) return { decision: 'unchanged', adopt_baseline: true };
  if (last === null) {
    return baseline.sync_source === 'seed' && db === null ? { decision: 'updated_in_excel' } : { decision: 'conflict_both_modified' };
  }
  // A missing current_db_hash means the record has not been touched since the last sync.
  return db === null || db === last ? { decision: 'updated_in_excel' } : { decision: 'conflict_both_modified' };
}

/**
 * Pure reconciliation: decides what to do with every incoming Excel row given
 * what the database remembers. It performs no I/O; the caller applies the
 * outcomes. Rows are matched by `source_key`, then by normalized name.
 */
export async function reconcileSheetsWithBaselines(rows: NormalizedRow[], baselines: Baseline[]): Promise<ReconcileResult> {
  const keyOf = (kind: string, key: string) => `${kind}|${key}`;
  const byKey = new Map<string, Baseline>();
  const byName = new Map<string, Baseline>();
  for (const b of baselines) {
    if (b.source_key) byKey.set(keyOf(b.kind, b.source_key), b);
    else byName.set(keyOf(b.kind, normalizeKey(b.name)), b);
  }

  const summary: Record<SyncDecision, number> = { new_from_excel: 0, unchanged: 0, updated_in_excel: 0, conflict_both_modified: 0 };
  const outcomes: RowOutcome[] = [];
  const matched = new Set<Baseline>();

  for (const row of rows) {
    const baseline = byKey.get(keyOf(row.kind, row.source_key)) ?? byName.get(keyOf(row.kind, normalizeKey(row.name)));
    if (baseline) matched.add(baseline);
    const incoming_excel_hash = await hashTrackedFields(row, row.kind);
    const outcome: RowOutcome = { ...decide(incoming_excel_hash, baseline), row, incoming_excel_hash, baseline };
    summary[outcome.decision]++;
    outcomes.push(outcome);
  }

  const missing_in_excel = baselines.filter((b) => b.sync_source === 'excel' && !matched.has(b));
  return { outcomes, missing_in_excel, summary };
}
