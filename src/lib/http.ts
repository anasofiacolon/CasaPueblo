export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(status: number, message: string, details?: unknown): Response {
  return json(details === undefined ? { error: message } : { error: message, details }, status);
}

/** Parses a JSON object body; anything else is a 400. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, 'El cuerpo de la solicitud debe ser JSON válido.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'El cuerpo de la solicitud debe ser un objeto JSON.');
  }
  return body as Record<string, unknown>;
}

/** Trimmed string or null (blank strings become null). Non-strings are rejected. */
export function optionalText(value: unknown, field: string, max = 5000): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `El campo ${field} debe ser texto.`);
  const text = value.trim();
  if (text === '') return null;
  if (text.length > max) throw new HttpError(400, `El campo ${field} excede ${max} caracteres.`);
  return text;
}

export function requiredText(value: unknown, field: string, max = 5000): string {
  const text = optionalText(value, field, max);
  if (text === null) throw new HttpError(400, `El campo ${field} es requerido.`);
  return text;
}

/** Accepts true/false/1/0; undefined falls back to the default. */
export function flag(value: unknown, field: string, fallback: 0 | 1): 0 | 1 {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw new HttpError(400, `El campo ${field} debe ser verdadero o falso.`);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}

/**
 * Coordinates are optional but come in pairs: both null, or both valid WGS84
 * values that are not (0, 0). Blank strings count as "not provided".
 */
export function coordinates(lat: unknown, lng: unknown): { latitude: number | null; longitude: number | null } {
  const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  if (blank(lat) && blank(lng)) return { latitude: null, longitude: null };
  if (blank(lat) || blank(lng)) throw new HttpError(400, 'Latitud y longitud deben enviarse juntas o dejarse en blanco.');
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new HttpError(400, 'Las coordenadas no son válidas.');
  }
  if (latitude === 0 && longitude === 0) throw new HttpError(400, 'Las coordenadas (0, 0) no son válidas.');
  return { latitude, longitude };
}

export function slugify(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'comunidad'
  );
}
