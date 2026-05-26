'use strict';
/**
 * supervisor.js — Vanguard Agent Output Supervisor (Hermes Pattern)
 *
 * Implements the supervisor pattern natively for Project Vanguard.
 * Classifies agent outputs into intent markers: [ACK], [ESCALATE], [RETRY], [SKIP].
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '../..');
const ACTIVITY_LOG = path.join(ROOT, 'memory/activity.jsonl');
const OUTPUT_EVENTS_LOG = path.join(ROOT, 'memory/output-events.jsonl');
const STATE_FILE = path.join(ROOT, 'memory/supervisor-state.json');
const SUPERVISOR_LOG = path.join(ROOT, 'memory/supervisor.log');

// ─── Intent Markers ───────────────────────────────────────────────────────────

const MARKERS = {
  ACK: '[ACK]',        // Clean output — loop closes silently
  ESCALATE: '[ESCALATE]', // Quality issue — Notify Human
  RETRY: '[RETRY]',    // Recoverable failure — queue for respawn
  SKIP: '[SKIP]',      // Not actionable — silent
};

// ─── Quality Rules ────────────────────────────────────────────────────────────

const QUALITY_RULES = [
  {
    name: 'timeout',
    check(event) {
      if (event.outcome === 'timeout' || event.outcome === 'timedOut') {
        return { escalate: true, reason: `Agent timed out after ${Math.round((event.duration_ms || 0) / 1000)}s` };
      }
    },
  },
  {
    name: 'error_outcome',
    check(event) {
      const reason = event.errorMessage || 'no detail';
      if (event.outcome === 'error' || event.outcome === 'failed') {
        return { escalate: true, reason: `Agent reported error outcome: ${reason}` };
      }
    },
  },
  {
    name: 'output_error_keyword',
    check(event) {
      if (!event.output) return;
      const text = String(event.output).toLowerCase();
      const HARD_ERRORS = [
        'unhandled exception',
        'segfault',
        'out of memory',
        'fatal error',
        'deployment failed',
        'build failed',
        'cannot find module',
      ];
      for (const kw of HARD_ERRORS) {
        if (text.includes(kw)) {
          return { escalate: true, reason: `Output contains hard error: "${kw}"` };
        }
      }
    },
  },
  {
    name: 'output_quality_warning',
    check(event) {
      if (!event.output) return;
      const text = String(event.output).toLowerCase();
      const SOFT_ERRORS = ['i was unable to', 'i cannot', 'i don\'t have access', 'permission denied'];
      for (const kw of SOFT_ERRORS) {
        if (text.includes(kw)) {
          return { escalate: true, reason: `Output may be incomplete: "${kw}"` };
        }
      }
    },
  },
];

function isRetryable(event) {
  if (event.outcome === 'timeout' && (event.duration_ms || 0) < 60000) return true;
  if (event.outcome === 'error' && event.errorMessage) {
    const transient = ['network', 'rate limit', '429', '503', 'timeout'];
    const msg = String(event.errorMessage).toLowerCase();
    if (transient.some(t => msg.includes(t))) return true;
  }
  return false;
}

// ─── State & Helpers ──────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      processedIds: [],
      retryQueue: [],
      lastRun: null,
      stats: { ack: 0, escalate: 0, retry: 0, skip: 0 },
    };
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {}
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    fs.appendFileSync(SUPERVISOR_LOG, line + '\n');
  } catch {}
}

function classify(event) {
  for (const rule of QUALITY_RULES) {
    const result = rule.check(event);
    if (result && result.escalate) {
      if (isRetryable(event)) return { marker: MARKERS.RETRY, reason: result.reason };
      return { marker: MARKERS.ESCALATE, reason: result.reason };
    }
  }
  return { marker: MARKERS.ACK, reason: 'Passed' };
}

// ─── Main Logic ───────────────────────────────────────────────────────────────

function run(opts = {}) {
  const lookbackMs = opts.lookbackMs || 3600000;
  const state = loadState();
  const processedSet = new Set(state.processedIds);
  const cutoff = new Date(Date.now() - lookbackMs);
  const results = { ack: 0, escalate: 0, retry: 0, skip: 0, processed: 0 };

  const events = [];
  [ACTIVITY_LOG, OUTPUT_EVENTS_LOG].forEach(logPath => {
    if (fs.existsSync(logPath)) {
      fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).forEach(line => {
        try {
          const e = JSON.parse(line);
          const id = `${e.ts}::${e.agentId || e.sessionId}`;
          if (!processedSet.has(id) && new Date(e.ts) > cutoff) {
            events.push({ ...e, _id: id });
          }
        } catch {}
      });
    }
  });

  events.forEach(event => {
    const { marker, reason } = classify(event);
    processedSet.add(event._id);
    results.processed++;
    results[marker.replace('[', '').replace(']', '').toLowerCase()]++;
    log(`${marker} ${event.agentId || 'unknown'} — ${reason}`);
  });

  state.processedIds = [...processedSet].slice(-2000);
  state.lastRun = new Date().toISOString();
  state.stats.ack += results.ack;
  state.stats.escalate += results.escalate;
  state.stats.retry += results.retry;
  state.stats.skip += results.skip;
  saveState(state);

  return results;
}

module.exports = { run, classify, MARKERS };
