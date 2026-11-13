import { currentAdmin } from './lib/auth';
import { HttpError, errorResponse, json } from './lib/http';
import { createAdmin, listAdmins, stats, updateAdmin } from './routes/admins';
import { login, logout, me } from './routes/auth';
import {
  createCommunity, deleteCommunity, getAdminCommunity, getPublicCommunity, listAdminCommunities, listAllies, listPublicCommunities, updateCommunity,
} from './routes/communities';
import { listProjectInfo, updateProjectInfo } from './routes/project-info';
import { approveSubmission, createSubmission, getSubmission, listSubmissions, rejectSubmission } from './routes/submissions';
import { syncConfig, syncExcel } from './routes/sync';
import type { Ctx, Env } from './types';

type Handler = (ctx: Ctx) => Promise<Response>;

async function health({ env }: Ctx): Promise<Response> {
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS tables FROM sqlite_master WHERE type = ?').bind('table').first<{ tables: number }>();
    return json({ status: 'ok', database: 'connected', tables: row?.tables ?? 0 });
  } catch {
    return json({ status: 'error', database: 'unreachable' }, 503);
  }
}

// Everything under /api/admin/ requires an administrator session (enforced in handleApi, not per route).
const routes: [method: string, pattern: string, handler: Handler][] = [
  ['GET', '/api/health', health],

  ['POST', '/api/auth/login', login],
  ['POST', '/api/auth/logout', logout],
  ['GET', '/api/auth/me', me],

  ['POST', '/api/submissions', createSubmission],
  ['GET', '/api/communities', listPublicCommunities],
  ['GET', '/api/communities/:slug', getPublicCommunity],
  ['GET', '/api/allies', listAllies],
  ['GET', '/api/project-info', listProjectInfo],

  ['GET', '/api/sync/excel', syncConfig],
  ['POST', '/api/sync/excel', syncExcel],

  ['GET', '/api/admin/stats', stats],
  ['GET', '/api/admin/submissions', listSubmissions],
  ['GET', '/api/admin/submissions/:id', getSubmission],
  ['POST', '/api/admin/submissions/:id/approve', approveSubmission],
  ['POST', '/api/admin/submissions/:id/reject', rejectSubmission],
  ['GET', '/api/admin/communities', listAdminCommunities],
  ['POST', '/api/admin/communities', createCommunity],
  ['GET', '/api/admin/communities/:id', getAdminCommunity],
  ['PUT', '/api/admin/communities/:id', updateCommunity],
  ['DELETE', '/api/admin/communities/:id', deleteCommunity],
  ['PUT', '/api/admin/project-info/:key', updateProjectInfo],
  ['GET', '/api/admin/administrators', listAdmins],
  ['POST', '/api/admin/administrators', createAdmin],
  ['PUT', '/api/admin/administrators/:id', updateAdmin],
];

function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) {
      if (got[i] === '') return null;
      try {
        params[want[i].slice(1)] = decodeURIComponent(got[i]);
      } catch {
        return null;
      }
    } else if (want[i] !== got[i]) return null;
  }
  if ('id' in params && !/^\d{1,15}$/.test(params.id)) return null;
  return params;
}

/** Cookie-authenticated writes must come from our own pages. */
function crossOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin');
  return origin !== null && origin !== url.origin;
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  let pathMatched = false;
  for (const [method, pattern, handler] of routes) {
    const params = match(pattern, path);
    if (!params) continue;
    pathMatched = true;
    if (method !== request.method) continue;

    const ctx: Ctx = { request, env, url, params, admin: null };
    if (request.method !== 'GET' && crossOrigin(request, url)) return errorResponse(403, 'Origen no permitido.');
    if (path.startsWith('/api/admin/')) {
      ctx.admin = await currentAdmin(request, env);
      if (!ctx.admin) return errorResponse(401, 'No autenticado.');
    }
    return handler(ctx);
  }
  // Unknown admin paths answer 401 before 404, so the API surface is not discoverable without a session.
  if (path.startsWith('/api/admin/') && !(await currentAdmin(request, env))) return errorResponse(401, 'No autenticado.');
  return pathMatched ? errorResponse(405, 'Método no permitido.') : errorResponse(404, 'Ruta no encontrada.');
}

/** Admin screens: everything under /admin/ except the login page needs a session. */
async function handleAdminPage(request: Request, env: Env, url: URL): Promise<Response> {
  const isLogin = /^\/admin\/login(\.html)?\/?$/.test(url.pathname);
  const isPage = !/\.[a-z0-9]+$/i.test(url.pathname) || url.pathname.endsWith('.html');
  if (isPage) {
    const admin = await currentAdmin(request, env).catch(() => null);
    if (!admin && !isLogin) return Response.redirect(new URL('/admin/login.html', url).toString(), 302);
    if (admin && (isLogin || /^\/admin\/?$/.test(url.pathname))) return Response.redirect(new URL('/admin/dashboard.html', url).toString(), 302);
  }
  const response = await env.ASSETS.fetch(request);
  if (!isPage) return response;
  // Admin HTML must never be served from a shared or back/forward cache after logout.
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await handleApi(request, env, url);
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return await handleAdminPage(request, env, url);
      return await env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err.status, err.message, err.details);
      console.error(err);
      return errorResponse(500, 'Error interno del servidor.');
    }
  },
} satisfies ExportedHandler<Env>;
