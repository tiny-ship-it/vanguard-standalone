#!/usr/bin/env node
'use strict';

/**
 * vanguard-doctor — one-command health check for Vanguard.
 *
 * Read-only by design. Mirrors tiny-doctor.js (tinywins-assistant/bin/tiny-doctor.js)
 * but checks Vanguard's components: Slack bridge, supervisor liveness, engine
 * activity log freshness, persistence DB, Memory Engine, Nango config,
 * repo cleanliness, disk.
 *
 * Hermes-integration Week 1 (see docs/hermes-integration.md).
 *
 * Runtime paths default to the checkout this script lives in. To probe a
 * different install (the canonical case: running from a worktree but
 * wanting to check the live runtime), set VANGUARD_ROOT:
 *
 *   VANGUARD_ROOT=/opt/openclaw/vanguard-standalone node scripts/vanguard-doctor.js
 *
 * Usage:
 *   node scripts/vanguard-doctor.js
 *   node scripts/vanguard-doctor.js --json     # machine-readable
 */

const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

// ROOT defaults to the checkout this script lives in. VANGUARD_ROOT env var
// overrides — set it to probe a different Vanguard install (e.g. running
// from a worktree but pointing at the live runtime).
const ROOT = process.env.VANGUARD_ROOT
  ? path.resolve(process.env.VANGUARD_ROOT)
  : path.resolve(__dirname, '..');
const MEMORY_DIR = path.join(ROOT, 'memory');
const VAULT_DIR = path.join(ROOT, 'vault');
const VANGUARD_JSON = path.join(ROOT, 'vanguard.json');
const MEMORY_ENGINE_URL =
  process.env.MEMORY_ENGINE_URL ||
  'https://memory-engine-230664305014.us-central1.run.app';
const SLACK_BRIDGE_HEALTH = process.env.SLACK_BRIDGE_HEALTH || 'http://127.0.0.1:3002/health';

const results = [];
let hadRed = false;
const jsonMode = process.argv.includes('--json');

function record(name, status, detail, extra) {
  results.push({ name, status, detail, ...(extra || {}) });
  if (status === 'red') hadRed = true;
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return fallback;
  }
}

function ageMin(filePath) {
  const stat = fs.statSync(filePath);
  return Math.round((Date.now() - stat.mtimeMs) / 60000);
}

// ─── 1. Slack bridge health ─────────────────────────────────────────────────
function checkSlackBridge() {
  const start = Date.now();
  const res = spawnSync('curl', ['-sS', '-m', '3', '-o', '-', '-w', '\n%{http_code}', SLACK_BRIDGE_HEALTH], {
    encoding: 'utf8',
  });
  const elapsed = Date.now() - start;
  if (res.status !== 0) {
    record('slack-bridge', 'red', `unreachable (${elapsed}ms): ${(res.stderr || '').trim().slice(0, 80)}`);
    return;
  }
  const parts = (res.stdout || '').split('\n');
  const code = (parts.pop() || '').trim();
  if (code === '200') {
    record('slack-bridge', 'green', `HTTP 200 in ${elapsed}ms`);
  } else if (code.startsWith('5')) {
    record('slack-bridge', 'red', `HTTP ${code} in ${elapsed}ms`);
  } else {
    record('slack-bridge', 'yellow', `HTTP ${code} in ${elapsed}ms`);
  }
}

// ─── 2. Supervisor liveness ─────────────────────────────────────────────────
function checkSupervisor() {
  const statePath = path.join(MEMORY_DIR, 'supervisor-state.json');
  if (!fs.existsSync(statePath)) {
    record('supervisor', 'yellow', 'no state file (never run?)');
    return;
  }
  const age = ageMin(statePath);
  let body;
  try {
    body = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (err) {
    record('supervisor', 'red', `state file unparseable: ${err.message}`);
    return;
  }
  const summary = body.last_event_at
    ? `last event ${age}m ago`
    : `state file ${age}m old`;
  // Vanguard's supervisor runs on every engine turn; a long quiet period is
  // either a quiet day or a stalled supervisor. We treat >6h as red.
  if (age > 360) record('supervisor', 'red', summary);
  else if (age > 60) record('supervisor', 'yellow', summary);
  else record('supervisor', 'green', summary);
}

// ─── 3. Engine activity log freshness ───────────────────────────────────────
function checkActivityLog() {
  const logPath = path.join(MEMORY_DIR, 'activity.jsonl');
  if (!fs.existsSync(logPath)) {
    record('engine-activity', 'yellow', 'activity.jsonl missing');
    return;
  }
  const age = ageMin(logPath);
  const sizeKB = Math.round(fs.statSync(logPath).size / 1024);
  if (age > 360) record('engine-activity', 'red', `idle ${age}m, ${sizeKB}KB`);
  else if (age > 60) record('engine-activity', 'yellow', `last write ${age}m ago, ${sizeKB}KB`);
  else record('engine-activity', 'green', `last write ${age}m ago, ${sizeKB}KB`);
}

// ─── 4. Persistence DB (better-sqlite3 vault) ───────────────────────────────
function checkPersistence() {
  // Probe via Node's better-sqlite3 against any *.db under vault/
  if (!fs.existsSync(VAULT_DIR)) {
    record('persistence', 'yellow', 'vault/ directory missing — no tenants provisioned yet');
    return;
  }
  let dbs = [];
  try {
    const stack = [VAULT_DIR];
    while (stack.length) {
      const dir = stack.pop();
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else if (ent.isFile() && /\.db$/.test(ent.name)) dbs.push(p);
      }
    }
  } catch (err) {
    record('persistence', 'red', `vault walk failed: ${err.message}`);
    return;
  }
  if (dbs.length === 0) {
    record('persistence', 'yellow', 'no SQLite files under vault/ yet');
    return;
  }
  // Try to require better-sqlite3 and run a trivial query against the newest db
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    record('persistence', 'yellow', `${dbs.length} db(s) present, better-sqlite3 not available to probe`);
    return;
  }
  const newest = dbs
    .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  try {
    const db = new Database(newest.p, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 5").all();
    db.close();
    record('persistence', 'green', `${dbs.length} db(s), newest=${path.basename(newest.p)}, ${rows.length} table(s) visible`);
  } catch (err) {
    record('persistence', 'red', `${path.basename(newest.p)} probe failed: ${err.message.slice(0, 80)}`);
  }
}

// ─── 5. Memory Engine reachability ──────────────────────────────────────────
function checkMemoryEngine() {
  const start = Date.now();
  const url = `${MEMORY_ENGINE_URL}/oauth/status`;
  const res = spawnSync('curl', ['-sS', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}', url], {
    encoding: 'utf8',
  });
  const elapsed = Date.now() - start;
  if (res.status !== 0) {
    record('memory-engine', 'red', `transport error (${elapsed}ms): ${(res.stderr || '').trim().slice(0, 80)}`);
    return;
  }
  const code = (res.stdout || '').trim();
  if (code.startsWith('5')) record('memory-engine', 'red', `HTTP ${code} in ${elapsed}ms`);
  else if (elapsed > 1000) record('memory-engine', 'yellow', `HTTP ${code} but slow: ${elapsed}ms`);
  else record('memory-engine', 'green', `HTTP ${code} in ${elapsed}ms`);
}

// ─── 6. Nango integration config ────────────────────────────────────────────
function checkNangoConfig() {
  const hasEnv = !!(process.env.NANGO_SECRET_KEY || process.env.NANGO_PUBLIC_KEY);
  const hasConnectorFile = fs.existsSync(path.join(ROOT, 'lib', 'connectors', 'nango.js'));
  if (!hasConnectorFile) {
    record('nango', 'yellow', 'lib/connectors/nango.js missing');
    return;
  }
  if (!hasEnv) {
    record('nango', 'yellow', 'NANGO_SECRET_KEY env not set on this host');
    return;
  }
  record('nango', 'green', 'connector + env present');
}

// ─── 7. Vanguard config sanity ──────────────────────────────────────────────
function checkVanguardJson() {
  if (!fs.existsSync(VANGUARD_JSON)) {
    record('vanguard-config', 'red', 'vanguard.json missing');
    return;
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(VANGUARD_JSON, 'utf8'));
  } catch (err) {
    record('vanguard-config', 'red', `unparseable: ${err.message}`);
    return;
  }
  const issues = [];
  if (!cfg.identity || !cfg.identity.name) issues.push('identity.name missing');
  if (!cfg.security) issues.push('security block missing');
  if (cfg.security && cfg.security.hardPartitioning !== true) {
    issues.push('security.hardPartitioning not enforced');
  }
  if (issues.length) record('vanguard-config', 'yellow', issues.join(' / '));
  else record('vanguard-config', 'green', `identity=${cfg.identity.name} hardPartitioning=on`);
}

// ─── 8. Repo cleanliness ────────────────────────────────────────────────────
function checkRepo() {
  const out = safe(
    () => execSync(`git -C ${ROOT} status --porcelain 2>&1`, { encoding: 'utf8', timeout: 3000 }),
    null,
  );
  if (out === null) {
    record('repo', 'yellow', 'git unavailable');
    return;
  }
  const dirty = out.trim().split('\n').filter(Boolean).length;
  const branch = safe(
    () => execSync(`git -C ${ROOT} branch --show-current`, { encoding: 'utf8' }).trim(),
    '?',
  );
  if (dirty === 0) record('repo', 'green', `clean on ${branch}`);
  else if (dirty < 10) record('repo', 'yellow', `${dirty} dirty paths on ${branch}`);
  else record('repo', 'red', `${dirty} dirty paths on ${branch}`);
}

// ─── 9. Disk usage ──────────────────────────────────────────────────────────
function checkDisk() {
  const out = safe(
    () => execSync(`df -P ${ROOT} 2>/dev/null`, { encoding: 'utf8' }),
    '',
  );
  const lines = out.trim().split('\n').slice(1);
  if (!lines.length) {
    record('disk', 'yellow', 'df returned nothing');
    return;
  }
  const parts = lines[0].trim().split(/\s+/);
  const mount = parts[parts.length - 1];
  const pct = parseInt(parts[parts.length - 2], 10);
  const detail = `${mount}=${pct}%`;
  if (pct >= 90) record('disk', 'red', detail);
  else if (pct >= 80) record('disk', 'yellow', detail);
  else record('disk', 'green', detail);
}

// ─── Run ────────────────────────────────────────────────────────────────────
function run() {
  const checks = [
    checkSlackBridge,
    checkSupervisor,
    checkActivityLog,
    checkPersistence,
    checkMemoryEngine,
    checkNangoConfig,
    checkVanguardJson,
    checkRepo,
    checkDisk,
  ];
  const start = Date.now();
  for (const c of checks) {
    try {
      c();
    } catch (err) {
      record(c.name, 'red', `crashed: ${err.message}`);
    }
  }
  const elapsed = Date.now() - start;

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ elapsed_ms: elapsed, results, summary: summarize() }, null, 2) + '\n');
    process.exit(hadRed ? 1 : 0);
  }

  const symbol = (s) => (s === 'green' ? `${GREEN}●${RESET}` : s === 'yellow' ? `${YELLOW}●${RESET}` : `${RED}●${RESET}`);
  console.log(`${BOLD}vanguard doctor${RESET}  ${DIM}(${elapsed}ms)${RESET}`);
  console.log();
  for (const r of results) {
    console.log(`  ${symbol(r.status)} ${r.name.padEnd(20)} ${DIM}${r.detail}${RESET}`);
  }
  console.log();
  const reds = results.filter((r) => r.status === 'red').length;
  const yellows = results.filter((r) => r.status === 'yellow').length;
  if (reds > 0) console.log(`${RED}${BOLD}${reds} red${RESET}${YELLOW}, ${yellows} yellow${RESET}`);
  else if (yellows > 0) console.log(`${YELLOW}${yellows} yellow${RESET}`);
  else console.log(`${GREEN}all green${RESET}`);

  process.exit(hadRed ? 1 : 0);
}

function summarize() {
  return {
    red: results.filter((r) => r.status === 'red').length,
    yellow: results.filter((r) => r.status === 'yellow').length,
    green: results.filter((r) => r.status === 'green').length,
  };
}

if (require.main === module) run();

module.exports = { run };
