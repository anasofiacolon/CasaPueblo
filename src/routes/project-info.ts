import { auditStatement } from '../lib/audit';
import { HttpError, json, readJsonObject, requiredText } from '../lib/http';
import type { Ctx } from '../types';

export async function listProjectInfo({ env }: Ctx): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT section_key, title, content, updated_at FROM project_info ORDER BY id').all();
  return json({ sections: results });
}

export async function updateProjectInfo(ctx: Ctx): Promise<Response> {
  const { env, request, params } = ctx;
  const admin = ctx.admin!;
  const current = await env.DB.prepare('SELECT id, title, content FROM project_info WHERE section_key = ?').bind(params.key).first<{ id: number; title: string; content: string }>();
  if (!current) throw new HttpError(404, 'Sección no encontrada.');
  const body = await readJsonObject(request);
  const title = body.title === undefined ? current.title : requiredText(body.title, 'title', 300);
  const content = body.content === undefined ? current.content : requiredText(body.content, 'content', 20000);
  await env.DB.batch([
    env.DB.prepare('UPDATE project_info SET title = ?, content = ?, updated_by_admin_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(title, content, admin.id, current.id),
    auditStatement(env, { entity_type: 'project_info', entity_id: current.id, action: 'update', previous_state: current, new_state: { title, content }, admin_id: admin.id }),
  ]);
  return json({ section: { section_key: params.key, title, content } });
}
