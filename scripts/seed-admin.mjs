#!/usr/bin/env node
// Creates the initial administrator account (idempotent).
//
//   npm run seed                      local D1, defaults to admin / admin123 for development
//   ADMIN_PASSWORD=... npm run seed:remote    production D1 (password required, 12+ characters)
//
// Optional env: ADMIN_USERNAME, ADMIN_NAME, ADMIN_EMAIL. Add --reset to replace
// the password of an existing account. The password is hashed here with the
// same PBKDF2-SHA256 format the Worker verifies; only the hash reaches the DB.
import { execFileSync } from 'node:child_process';
import { randomBytes, webcrypto } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const remote = args.includes('--remote');
const reset = args.includes('--reset');

const username = (process.env.ADMIN_USERNAME ?? 'admin').trim().toLowerCase();
const fullName = process.env.ADMIN_NAME ?? 'Administrador';
const email = process.env.ADMIN_EMAIL || null;
const password = process.env.ADMIN_PASSWORD ?? (remote ? '' : 'admin123');

if (!/^[a-z0-9._-]{3,50}$/.test(username)) fail('ADMIN_USERNAME must be 3–50 characters: letters, digits, dot, dash or underscore.');
if (remote && password.length < 12) fail('Set ADMIN_PASSWORD (12+ characters) to seed the production database.');
if (password.length < 8) fail('ADMIN_PASSWORD must be at least 8 characters.');

function fail(message) {
  console.error(`seed-admin: ${message}`);
  process.exit(1);
}

const ITERATIONS = 100_000;
const salt = webcrypto.getRandomValues(new Uint8Array(16));
const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
const hash = `pbkdf2_sha256$${ITERATIONS}$${Buffer.from(salt).toString('base64')}$${Buffer.from(bits).toString('base64')}`;

const q = (v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const onConflict = reset ? 'DO UPDATE SET password_hash = excluded.password_hash, is_active = 1, updated_at = CURRENT_TIMESTAMP' : 'DO NOTHING';
const sql = `INSERT INTO administrators (username, password_hash, full_name, email)
VALUES (${q(username)}, ${q(hash)}, ${q(fullName)}, ${q(email)})
ON CONFLICT(username) ${onConflict};\n`;

// Local development needs its own secrets; generate each one once (.dev.vars is git-ignored).
if (!remote) {
  const devVars = join(root, '.dev.vars');
  if (!existsSync(devVars)) writeFileSync(devVars, '', { mode: 0o600 });
  for (const name of ['JWT_SECRET', 'SYNC_TOKEN']) {
    const current = readFileSync(devVars, 'utf8');
    if (new RegExp(`^${name}=.+$`, 'm').test(current)) continue;
    appendFileSync(devVars, `${current === '' || current.endsWith('\n') ? '' : '\n'}${name}=${randomBytes(32).toString('hex')}\n`);
    console.log(`Added a random ${name} to .dev.vars.`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'cp-seed-'));
const file = join(dir, 'admin.sql');
try {
  writeFileSync(file, sql, { mode: 0o600 });
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', remote ? '--remote' : '--local', '--file', file, '--yes'], { cwd: root, stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`Administrator "${username}" is ready on the ${remote ? 'remote' : 'local'} database${reset ? ' (password reset)' : ' (left unchanged if it already existed)'}.`);
