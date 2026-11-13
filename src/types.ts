export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** HMAC key for session JWTs. `.dev.vars` locally, `wrangler secret put` in production. */
  JWT_SECRET?: string;
  /** Optional bearer token that lets Power Automate / scripts call /api/sync/excel. */
  SYNC_TOKEN?: string;
  /** Optional read-only JSON feed of the workbook, used by POST /api/sync/excel {"source":"feed"}. */
  EXCEL_FEED_URL?: string;
}

export interface AdminSession {
  id: number;
  username: string;
  full_name: string;
  email: string | null;
}

export interface Ctx {
  request: Request;
  env: Env;
  url: URL;
  params: Record<string, string>;
  /** Set for routes registered as admin-only. */
  admin: AdminSession | null;
}
