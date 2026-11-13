import type { Env } from '../types';

export type AuditEntity = 'submission' | 'community' | 'project_info' | 'auth' | 'excel_sync';

export interface AuditEntry {
  entity_type: AuditEntity;
  entity_id?: number | null;
  action: string;
  previous_state?: unknown;
  new_state?: unknown;
  comment?: string | null;
  admin_id?: number | null;
}

const text = (v: unknown) => (v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v));

export function auditStatement(env: Env, e: AuditEntry): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO audit_logs (entity_type, entity_id, action, previous_state, new_state, comment, admin_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(e.entity_type, e.entity_id ?? null, e.action, text(e.previous_state), text(e.new_state), e.comment ?? null, e.admin_id ?? null);
}

export async function audit(env: Env, e: AuditEntry): Promise<void> {
  await auditStatement(env, e).run();
}
