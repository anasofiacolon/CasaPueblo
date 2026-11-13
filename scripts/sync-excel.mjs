#!/usr/bin/env node
// One-way sync: reads Casa Pueblo's workbook and sends its rows to /api/sync/excel.
// The workbook is opened read-only and is never modified or uploaded as a file.
//
//   npm run sync:excel                       dry run against http://localhost:8787 (needs `npm run dev`)
//   npm run sync:excel -- --apply            write the changes to the local database
//   SYNC_TOKEN=... npm run sync:excel -- --url https://<worker>.workers.dev --apply     production
//
// Optional: --file <path> (default: the only .xlsx inside private/).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkbook } from './read-xlsx.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const fail = (message) => { console.error(`sync-excel: ${message}`); process.exit(1); };

const apply = args.includes('--apply');
const url = (option('--url') ?? 'http://localhost:8787').replace(/\/+$/, '');
const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url);
if (!isLocal && !url.startsWith('https://')) fail('A remote --url must use https:// so the token and the data travel encrypted.');

let file = option('--file');
if (!file) {
  const dir = join(root, 'private');
  const found = existsSync(dir) ? readdirSync(dir).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$')) : [];
  if (found.length !== 1) fail(found.length ? 'There are several workbooks in private/. Choose one with --file.' : 'Put the workbook in private/ (git-ignored) or pass --file <path>.');
  file = join(dir, found[0]);
}

// The token comes from the environment, or from .dev.vars when targeting the local server.
let token = process.env.SYNC_TOKEN;
if (!token && isLocal && existsSync(join(root, '.dev.vars'))) {
  token = /^SYNC_TOKEN=(.+)$/m.exec(readFileSync(join(root, '.dev.vars'), 'utf8'))?.[1]?.trim();
}
if (!token) fail(isLocal ? 'No SYNC_TOKEN in .dev.vars. Run `npm run seed` to generate one, then restart `npm run dev`.' : 'Set SYNC_TOKEN to the value stored with `wrangler secret put SYNC_TOKEN`.');

const sheets = readWorkbook(file);
console.log(`Workbook: ${file}`);
for (const s of sheets) console.log(`  ${s.name}: ${Math.max(0, s.values.length - 1)} rows below the header`);

let res;
try {
  res = await fetch(`${url}/api/sync/excel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ dry_run: !apply, sheets }),
  });
} catch (err) {
  fail(`Could not reach ${url} (${err.cause?.code ?? err.message}).${isLocal ? ' Is `npm run dev` running?' : ''}`);
}
const report = await res.json().catch(() => ({}));
if (!res.ok) fail(`${res.status} ${report.error ?? res.statusText}`);

// Names and decisions only: contact details and notes are never printed.
console.log(`\n${apply ? 'APPLIED to' : 'DRY RUN against'} ${url}\n`);
const width = Math.max(...report.rows.map((r) => r.name.length), 4);
for (const r of report.rows) console.log(`  ${r.decision.padEnd(22)} ${r.kind.padEnd(9)} ${r.name.padEnd(width)}  (${r.sheet})`);
console.log('\nSummary:', report.summary);
if (report.skipped.length) console.log('Skipped rows:', report.skipped);
if (report.missing_in_excel.length) console.log('In the database but no longer in the workbook (not deleted):', report.missing_in_excel.map((m) => m.name));
if (!apply) console.log('\nNothing was written. Re-run with --apply to update the database.');
