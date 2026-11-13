import { auditStatement } from '../lib/audit';
import { HttpError, json, optionalText, readJsonObject, requiredText } from '../lib/http';
import type { Ctx } from '../types';

export async function listProjectInfo({ env }: Ctx): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT section_key, title, content, updated_at FROM project_info ORDER BY id').all();
  return json({ sections: results });
}

function textList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, `El campo ${field} debe ser una lista.`);
  const items = value.map((v) => optionalText(v, field, maxLength)).filter((v): v is string => v !== null);
  if (items.length > maxItems) throw new HttpError(400, `El campo ${field} admite hasta ${maxItems} elementos.`);
  return items;
}

/**
 * A section's content is a small JSON document that proyecto.html knows how to
 * draw. Accepts the object or its JSON text, keeps only the known keys and
 * returns the canonical JSON to store. Everything is plain text: the public
 * page escapes it, so no markup can be injected through the editor.
 */
export function normalizeSectionContent(input: unknown): string {
  let c: unknown = input;
  if (typeof input === 'string') {
    try {
      c = JSON.parse(input);
    } catch {
      throw new HttpError(400, 'El contenido debe ser JSON válido.');
    }
  }
  if (c === null || typeof c !== 'object' || Array.isArray(c)) throw new HttpError(400, 'El contenido debe ser un objeto.');
  const o = c as Record<string, unknown>;
  if (o.items !== undefined && o.items !== null && !Array.isArray(o.items)) throw new HttpError(400, 'El campo items debe ser una lista.');
  const items = ((o.items as unknown[] | undefined) ?? []).map((item) => {
    const i = (item ?? {}) as Record<string, unknown>;
    return { title: requiredText(i.title, 'título de la tarjeta', 200), text: requiredText(i.text, 'texto de la tarjeta', 2000) };
  });
  if (items.length > 12) throw new HttpError(400, 'Se admiten hasta 12 tarjetas.');

  const out: Record<string, unknown> = {};
  const eyebrow = optionalText(o.eyebrow, 'eyebrow', 120);
  const paragraphs = textList(o.paragraphs, 'paragraphs', 10, 3000);
  const note = optionalText(o.note, 'note', 1500);
  const listTitle = optionalText(o.list_title, 'list_title', 200);
  const list = textList(o.list, 'list', 20, 200);
  if (eyebrow) out.eyebrow = eyebrow;
  if (paragraphs.length) out.paragraphs = paragraphs;
  if (listTitle) out.list_title = listTitle;
  if (list.length) out.list = list;
  if (items.length) out.items = items;
  if (note) out.note = note;
  if (Object.keys(out).length === 0) throw new HttpError(400, 'La sección no puede quedar vacía.');
  return JSON.stringify(out);
}

export async function updateProjectInfo(ctx: Ctx): Promise<Response> {
  const { env, request, params } = ctx;
  const admin = ctx.admin!;
  const current = await env.DB.prepare('SELECT id, title, content FROM project_info WHERE section_key = ?').bind(params.key).first<{ id: number; title: string; content: string }>();
  if (!current) throw new HttpError(404, 'Sección no encontrada.');
  const body = await readJsonObject(request);
  const title = body.title === undefined ? current.title : requiredText(body.title, 'title', 300);
  const content = body.content === undefined ? current.content : normalizeSectionContent(body.content);
  await env.DB.batch([
    env.DB.prepare('UPDATE project_info SET title = ?, content = ?, updated_by_admin_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(title, content, admin.id, current.id),
    auditStatement(env, { entity_type: 'project_info', entity_id: current.id, action: 'update', previous_state: current, new_state: { title, content }, admin_id: admin.id }),
  ]);
  return json({ section: { section_key: params.key, title, content } });
}
