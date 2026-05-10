/**
 * signal-synthesizer.js — Core synthesis engine for X-post signal reconciliation
 *
 * After a burst of X posts settles (5 min of silence), this module:
 *   1. Reads INBOX.md and extracts unsynthesized [source: x-post] items
 *   2. Clusters them by project area
 *   3. Calls Sonnet to reconcile (merge, supersede, resolve conflicts)
 *   4. Atomically rewrites INBOX.md
 *   5. Logs the run to memory/synthesis-runs.jsonl
 *   6. DMs Patrick with a concise summary
 *
 * Exported API:
 *   resetDebounce()                  — Call after each INBOX write. Resets 5-min timer.
 *   checkAndRunSynthesis(opts)       — Heartbeat fallback entry point.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const WORKSPACE    = path.join(__dirname, '..');
const INBOX_PATH   = path.join(WORKSPACE, 'INBOX.md');
const PRIO_PATH    = path.join(WORKSPACE, 'PRIORITIES.md');
const RUNS_LOG     = path.join(WORKSPACE, 'memory', 'synthesis-runs.jsonl');
const HB_STATE     = path.join(WORKSPACE, 'memory', 'heartbeat-state.json');
const LOCK_PATH    = INBOX_PATH + '.lock';
const ACTIVITY_LOG = path.join(WORKSPACE, 'memory', 'subagent-activity.jsonl');
const SLACK_TARGET = 'user:U09FF5JBXFW';

// ─── Config ───────────────────────────────────────────────────────────────────

const DEBOUNCE_MS       = parseInt(process.env.SYNTH_DEBOUNCE_MS  || '300000', 10); // 5 min
const MIN_SIGNALS       = parseInt(process.env.SYNTH_MIN_SIGNALS  || '2',      10);
const MAX_SIGNALS       = parseInt(process.env.SYNTH_MAX_SIGNALS  || '20',     10);
const STALE_MS          = parseInt(process.env.SYNTH_STALE_MS     || '600000', 10); // 10 min
const MAX_DEFERRALS     = parseInt(process.env.SYNTH_MAX_DEFER    || '3',      10);
const SYNTH_MODEL       = process.env.SYNTH_MODEL || 'claude-sonnet-4-20250514';

// ─── Debounce State ───────────────────────────────────────────────────────────

let _debounceTimer  = null;
let _deferralCount  = 0;

/**
 * Call after every successful INBOX write.
 * Resets the 5-min countdown. When silence holds, synthesis fires.
 */
function resetDebounce() {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
  }
  _deferralCount = 0;
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    log('[signal-synthesizer] Debounce fired — running synthesis');
    synthesize({ trigger: 'debounce' }).catch((err) => {
      log(`[signal-synthesizer] Synthesis error: ${err.message}`);
    });
  }, DEBOUNCE_MS);
  log(`[signal-synthesizer] Debounce timer reset (fires in ${DEBOUNCE_MS / 1000}s)`);
}

// ─── Heartbeat Fallback ───────────────────────────────────────────────────────

/**
 * Called from hooks/signal-synthesizer/handler.js on heartbeat events.
 * Checks for stale unsynthesized signals (older than STALE_MS) and runs if found.
 */
async function checkAndRunSynthesis({ trigger = 'heartbeat' } = {}) {
  try {
    if (!fs.existsSync(INBOX_PATH)) return;
    const content = fs.readFileSync(INBOX_PATH, 'utf8');
    const pending  = parsePendingSignals(content);

    if (pending.length < MIN_SIGNALS) {
      log(`[signal-synthesizer] Heartbeat check: only ${pending.length} pending signal(s), skipping`);
      return;
    }

    // Check if oldest signal is stale
    const oldestIngest = pending
      .map((s) => new Date(s.meta.ingested || 0).getTime())
      .filter((t) => !isNaN(t))
      .sort()[0];

    const ageMs = Date.now() - (oldestIngest || 0);
    if (ageMs < STALE_MS) {
      log(`[signal-synthesizer] Heartbeat: oldest signal is ${Math.round(ageMs / 60000)}m old — below stale threshold, skipping`);
      return;
    }

    log(`[signal-synthesizer] Heartbeat fallback: ${pending.length} stale signals, running synthesis`);
    await synthesize({ trigger });
  } catch (err) {
    log(`[signal-synthesizer] Heartbeat check error: ${err.message}`);
  }
}

// ─── Main Orchestrator ────────────────────────────────────────────────────────

/**
 * Full synthesis run.
 * @param {Object} opts
 * @param {string} opts.trigger  — 'debounce' | 'heartbeat' | 'manual'
 */
async function synthesize({ trigger = 'debounce' } = {}) {
  const runId    = 'synth_' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
  const startMs  = Date.now();
  let runLog = {
    run_id:           runId,
    timestamp:        new Date().toISOString(),
    trigger,
    input_signals:    [],
    clusters_found:   0,
    items_merged:     0,
    items_superseded: 0,
    items_unchanged:  0,
    output_items:     0,
    model:            SYNTH_MODEL,
    tokens_used:      0,
    duration_ms:      0,
    notified_patrick: false,
    error:            null,
  };

  // ── Phase 0: Acquire lock ──────────────────────────────────────────────────
  if (!acquireLock()) {
    log('[signal-synthesizer] Could not acquire lock — skipping this run');
    appendRunLog({ ...runLog, error: 'lock_contention', duration_ms: Date.now() - startMs });
    return;
  }

  try {
    // ── Phase 0b: Agent concurrency check ─────────────────────────────────────
    const deferred = await checkDeferral(runId, startMs, runLog);
    if (deferred) return; // deferral scheduled, we're done for now

    // ── Phase 1: Parse pending signals ────────────────────────────────────────
    if (!fs.existsSync(INBOX_PATH)) {
      log('[signal-synthesizer] INBOX.md not found, nothing to synthesize');
      releaseLock();
      return;
    }

    const inboxContent = fs.readFileSync(INBOX_PATH, 'utf8');
    const pending = parsePendingSignals(inboxContent);
    runLog.input_signals = pending.map((s) => s.meta['signal-id']).filter(Boolean);

    if (pending.length < MIN_SIGNALS) {
      log(`[signal-synthesizer] Only ${pending.length} unsynthesized signal(s) — min is ${MIN_SIGNALS}, skipping`);
      releaseLock();
      return;
    }

    // Clamp to max
    const signals = pending.slice(0, MAX_SIGNALS);
    if (signals.length < pending.length) {
      log(`[signal-synthesizer] Capped at ${MAX_SIGNALS} signals (${pending.length} total pending)`);
    }

    // ── Phase 2: Load context ─────────────────────────────────────────────────
    const prioritiesContent = fs.existsSync(PRIO_PATH) ? fs.readFileSync(PRIO_PATH, 'utf8') : '';
    const inProgress = parseInProgressItems(prioritiesContent);

    // ── Phase 3: Cluster by project area ─────────────────────────────────────
    const clusters = clusterByArea(signals);
    runLog.clusters_found = Object.keys(clusters).length;

    // ── Phase 4: LLM reconciliation per cluster ───────────────────────────────
    const reconciledItems  = [];
    const supersededIds    = [];
    let   totalTokens      = 0;

    for (const [area, clusterSignals] of Object.entries(clusters)) {
      if (clusterSignals.length === 1) {
        // Single signal — mark synthesized, no merge needed
        const item = clusterSignals[0];
        item.meta.synthesized = 'true';
        reconciledItems.push({ ...item, singlePassthrough: true });
        runLog.items_unchanged++;
        continue;
      }

      // Call Sonnet
      let llmResult;
      try {
        const { result, tokensUsed } = await callSonnetForCluster(area, clusterSignals, inProgress, runId);
        llmResult    = result;
        totalTokens += tokensUsed;
      } catch (err) {
        log(`[signal-synthesizer] LLM call failed for cluster '${area}': ${err.message}`);
        // Preserve original items — mark as synthesized:false (unchanged)
        throw err; // Will be caught by outer try/catch — abort entire run
      }

      // Build reconciled entries
      for (const merged of (llmResult.merged_items || [])) {
        reconciledItems.push(buildReconciledEntry(merged, area, runId));
        runLog.items_merged++;
      }

      // Track superseded
      for (const sup of (llmResult.superseded || [])) {
        supersededIds.push(sup);
        runLog.items_superseded++;
      }
    }

    // ── Phase 5: Deduplicate cross-cluster ────────────────────────────────────
    const deduped = deduplicateBySourceSignals(reconciledItems);
    runLog.output_items = deduped.length;
    runLog.tokens_used  = totalTokens;

    // ── Phase 6: Priority ranking ─────────────────────────────────────────────
    const ranked = rankByPriority(deduped, inProgress);

    // ── Phase 7: Atomic write ─────────────────────────────────────────────────
    const newInbox = rebuildInbox({
      original:       inboxContent,
      pendingSignals: signals,
      reconciledItems: ranked,
      supersededIds,
    });

    writeAtomic(INBOX_PATH, newInbox);
    log(`[signal-synthesizer] ✅ INBOX.md rewritten atomically`);

    releaseLock();

    // ── Phase 8: State tracking ───────────────────────────────────────────────
    runLog.duration_ms = Date.now() - startMs;
    updateHeartbeatState(runLog);
    appendRunLog(runLog);

    // ── Phase 9: Notify Patrick ───────────────────────────────────────────────
    const notified = await notifyPatrick(ranked, supersededIds, runLog);
    runLog.notified_patrick = notified;
    // Re-log with notification status
    appendRunLog({ ...runLog, _update: true });

    log(`[signal-synthesizer] Run ${runId} complete — ${runLog.items_merged} merged, ${runLog.items_superseded} superseded, ${runLog.items_unchanged} unchanged`);

  } catch (err) {
    releaseLock();
    runLog.error       = err.message;
    runLog.duration_ms = Date.now() - startMs;
    appendRunLog(runLog);

    log(`[signal-synthesizer] ❌ Run ${runId} failed: ${err.message}`);

    // Notify Patrick of failure
    try {
      log(`⚠️ *Signal synthesis failed*: ${err.message}. Raw signals preserved in INBOX.md. Will retry on next heartbeat.`);
    } catch {}
  }
}

// ─── Deferral Logic ───────────────────────────────────────────────────────────

/**
 * Check if an agent is actively working from the queue.
 * If so, schedule a retry and return true (caller should exit).
 */
async function checkDeferral(runId, startMs, runLog) {
  if (isAgentWorkingFromQueue()) {
    _deferralCount++;
    if (_deferralCount <= MAX_DEFERRALS) {
      log(`[signal-synthesizer] Agent active — deferring synthesis (deferral ${_deferralCount}/${MAX_DEFERRALS})`);
      setTimeout(() => {
        synthesize({ trigger: 'deferral' }).catch((err) => {
          log(`[signal-synthesizer] Deferred synthesis error: ${err.message}`);
        });
      }, DEBOUNCE_MS);
      releaseLock();
      return true;
    } else {
      log(`[signal-synthesizer] Max deferrals (${MAX_DEFERRALS}) reached — running anyway with warning`);
      runLog._deferral_warning = true;
    }
  }
  return false;
}

function isAgentWorkingFromQueue() {
  try {
    if (!fs.existsSync(ACTIVITY_LOG)) return false;
    const lines = fs.readFileSync(ACTIVITY_LOG, 'utf8').trim().split('\n');
    const recent = lines.slice(-20).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    const fiveMinAgo = Date.now() - 300000;
    return recent.some(
      (e) => e.source === 'inbox' && e.status === 'in-progress' && new Date(e.timestamp).getTime() > fiveMinAgo
    );
  } catch {
    return false;
  }
}

// ─── INBOX Parser ─────────────────────────────────────────────────────────────

/**
 * Parse INBOX.md and return items with [source: x-post] and [synthesized: false].
 * Skips items without Meta block, already synthesized, or superseded (struck-through heading).
 *
 * @param {string} content — Full INBOX.md text
 * @returns {Array<{rawText: string, heading: string, meta: Object}>}
 */
function parsePendingSignals(content) {
  // Split on ### headings at line start
  const chunks = content.split(/(?=^### )/m);
  const pending = [];

  for (const chunk of chunks) {
    if (!chunk.trim().startsWith('### ')) continue;

    // Skip struck-through headings (superseded items)
    const headingLine = chunk.split('\n')[0];
    if (headingLine.includes('~~')) continue;

    // Parse Meta block
    const meta = extractMeta(chunk);
    if (!meta) continue;

    // Only process [source: x-post] + [synthesized: false]
    if (meta.source !== 'x-post') continue;
    if (meta.synthesized !== 'false') continue;
    if (!meta['signal-id']) continue;

    pending.push({ rawText: chunk, heading: headingLine, meta });
  }

  return pending;
}

/**
 * Extract key-value pairs from **Meta:** block.
 * Returns null if no Meta block found.
 */
function extractMeta(itemText) {
  const metaIdx = itemText.indexOf('**Meta:**');
  if (metaIdx === -1) return null;

  const metaSection = itemText.slice(metaIdx);
  const meta = {};
  const lineRe = /^- \[([^:]+): ([^\]]*)\]/gm;
  let m;
  while ((m = lineRe.exec(metaSection)) !== null) {
    meta[m[1].trim()] = m[2].trim();
  }

  return Object.keys(meta).length > 0 ? meta : null;
}

// ─── Cluster ──────────────────────────────────────────────────────────────────

/**
 * Group signals by project area.
 * Signals with multiple areas appear in multiple clusters.
 */
function clusterByArea(signals) {
  const clusters = {};
  for (const signal of signals) {
    const areas = (signal.meta['project-areas'] || 'other').split(',').map((s) => s.trim());
    for (const area of areas) {
      if (!clusters[area]) clusters[area] = [];
      clusters[area].push(signal);
    }
  }
  return clusters;
}

// ─── LLM Call ─────────────────────────────────────────────────────────────────

const SYNTHESIS_SYSTEM_PROMPT = `You are a signal reconciliation engine for a software development team.
You receive a batch of raw signals (extracted from X/Twitter posts) that
belong to the same project area. Your job is to:

1. CLUSTER: Identify which signals are about the same topic/feature
2. MERGE: Combine additive signals into a single richer specification.
   Preserve all unique action items. Combine summaries.
3. SUPERSEDE: If a newer signal explicitly replaces or contradicts an
   older one, mark the older as superseded. Preserve constraints from
   the older signal UNLESS the newer one explicitly contradicts them.
4. RESOLVE CONFLICTS: When two signals conflict without explicit
   supersession, newer wins for the primary direction, but preserve
   constraints and caveats from the older signal.
5. PRIORITIZE: Assign P0/P1/P2/P3 based on:
   - P0: Security, data loss, production breakage
   - P1: Directly unblocks current sprint work
   - P2: Strategic value, improves capability
   - P3: Nice to have, exploratory

Output STRICT JSON matching the schema below. No markdown, no explanation.`;

async function callSonnetForCluster(area, signals, inProgress, runId) {
  // Build user prompt
  const signalsSummary = signals.map((s, i) => {
    const lines = s.rawText.split('\n');
    const heading = lines[0];
    const metaEnd = s.rawText.indexOf('**Meta:**');
    const bodyText = metaEnd > 0 ? s.rawText.slice(0, metaEnd).trim() : s.rawText;
    return `--- Signal ${i + 1} (${s.meta['signal-id']}) ingested ${s.meta.ingested || 'unknown'} ---\n${bodyText}`;
  }).join('\n\n');

  const inProgressSummary = inProgress.length > 0
    ? `\n\nCurrently in-progress priorities for context:\n${inProgress.map((p) => `- ${p}`).join('\n')}`
    : '';

  const userPrompt = `Project area: ${area}
Run ID: ${runId}

${signalsSummary}${inProgressSummary}

Output JSON schema:
{
  "merged_items": [
    {
      "title": "concise title for the reconciled item",
      "summary": "combined summary, 2-4 sentences",
      "source_signals": ["sig_xxx", "sig_yyy"],
      "actions": [
        { "text": "action item text", "from_signal": "sig_xxx" }
      ],
      "priority": "P0|P1|P2|P3",
      "rationale": "why these were merged, what changed"
    }
  ],
  "superseded": [
    {
      "signal_id": "sig_xxx",
      "superseded_by": "sig_yyy",
      "reason": "why this signal is superseded"
    }
  ],
  "conflicts_resolved": [
    {
      "signal_a": "sig_xxx",
      "signal_b": "sig_yyy",
      "resolution": "what was decided",
      "rationale": "why newer/which constraints preserved"
    }
  ]
}`;

  // Resolve API key
  const apiKey = resolveAnthropicKey();
  if (apiKey && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = apiKey;
  }

  const { callLlm } = require('./llm-client');
  const raw = await callLlm({
    prompt: `${SYNTHESIS_SYSTEM_PROMPT}\n\n${userPrompt}`,
    model:     SYNTH_MODEL,
    maxTokens: 4000,
    temperature: 0.2,
  });

  // Parse JSON
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in Sonnet response for cluster '${area}'`);

  let result;
  try {
    result = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`JSON parse failed for cluster '${area}': ${e.message}\nRaw: ${raw.slice(0, 300)}`);
  }

  // Estimate tokens (rough: ~4 chars = 1 token)
  const tokensUsed = Math.ceil((userPrompt.length + raw.length) / 4);

  return { result, tokensUsed };
}

// ─── Entry Builders ───────────────────────────────────────────────────────────

function buildReconciledEntry(merged, area, runId) {
  const today = new Date().toISOString().slice(0, 10);
  const sourceSignals = (merged.source_signals || []).join(', ');
  const actions = (merged.actions || [])
    .map((a) => `- [ ] ${a.text} *(from ${a.from_signal})*`)
    .join('\n');

  const rawText = `### [${today}] [SYNTH] ${merged.title || 'Synthesized Signal'}
**Source signals:** ${sourceSignals}
**Summary:** ${merged.summary || ''}
**Project Area:** ${area}
**Priority:** ${merged.priority || 'P2'}
**Rationale:** ${merged.rationale || ''}
**Actions:**
${actions || '- [ ] Review synthesized item'}
**Status:** Open
**Meta:**
- [source: x-post-synthesized]
- [synthesis-run: ${runId}]
- [synthesized: true]
- [confidence: high]
- [project-areas: ${area}]
`;

  return {
    rawText,
    heading: `### [${today}] [SYNTH] ${merged.title || 'Synthesized Signal'}`,
    meta: { source: 'x-post-synthesized', synthesized: 'true', 'project-areas': area, 'synthesis-run': runId },
    priority: merged.priority || 'P2',
    sourceSignals: merged.source_signals || [],
    singlePassthrough: false,
  };
}

// ─── Deduplication ────────────────────────────────────────────────────────────

/**
 * Remove duplicate reconciled items produced when a signal appeared in multiple clusters.
 * Two items are duplicates if their source_signals sets are identical.
 */
function deduplicateBySourceSignals(items) {
  const seen  = new Set();
  const out   = [];
  for (const item of items) {
    const key = (item.sourceSignals || []).slice().sort().join(',') || item.meta?.['signal-id'] || Math.random().toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// ─── Priority Ranking ─────────────────────────────────────────────────────────

function rankByPriority(items, inProgress) {
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return [...items].sort((a, b) => {
    const pa = order[a.priority] ?? 2;
    const pb = order[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;

    // P1 tiebreak: alignment with in-progress work
    if (pa === 1) {
      const aAligned = inProgress.some((p) => a.rawText?.toLowerCase().includes(p.toLowerCase()));
      const bAligned = inProgress.some((p) => b.rawText?.toLowerCase().includes(p.toLowerCase()));
      if (aAligned && !bAligned) return -1;
      if (!aAligned && bAligned)  return  1;
    }

    // P2 tiebreak: number of source signals
    const aSignals = (a.sourceSignals || []).length;
    const bSignals = (b.sourceSignals || []).length;
    return bSignals - aSignals; // more signals first
  });
}

// ─── INBOX Rebuild ────────────────────────────────────────────────────────────

/**
 * Rebuild INBOX.md:
 *   - Preserve all non-x-post items byte-for-byte
 *   - Replace pending x-post items with reconciled items (superseded items get struck-through)
 *   - Prepend reconciled items after the first H1/header section
 *
 * @param {Object} opts
 * @param {string}   opts.original         — Original INBOX.md content
 * @param {Array}    opts.pendingSignals    — Pending signals that were processed
 * @param {Array}    opts.reconciledItems  — New reconciled entries to add
 * @param {Array}    opts.supersededIds    — [{signal_id, superseded_by, reason}]
 */
function rebuildInbox({ original, pendingSignals, reconciledItems, supersededIds }) {
  // Build a set of signal IDs being processed
  const processedIds = new Set(pendingSignals.map((s) => s.meta['signal-id']).filter(Boolean));
  const supersededMap = {};
  for (const sup of supersededIds) {
    if (sup.signal_id) supersededMap[sup.signal_id] = sup;
  }

  // Split original into chunks
  const chunks = original.split(/(?=^### )/m);
  const preamble = chunks[0].startsWith('### ') ? '' : chunks[0];
  const items    = chunks[0].startsWith('### ') ? chunks : chunks.slice(1);

  const outputItems = [];

  for (const chunk of items) {
    if (!chunk.trim().startsWith('### ')) {
      outputItems.push(chunk);
      continue;
    }

    const meta = extractMeta(chunk);
    const signalId = meta?.['signal-id'];

    // Not a processed x-post — preserve as-is
    if (!signalId || !processedIds.has(signalId)) {
      outputItems.push(chunk);
      continue;
    }

    // Superseded — strike through heading and update status/meta
    if (supersededMap[signalId]) {
      const sup = supersededMap[signalId];
      outputItems.push(markSuperseded(chunk, signalId, sup));
      continue;
    }

    // Single passthrough — just mark synthesized
    if (reconciledItems.some((r) => r.singlePassthrough && r.meta?.['signal-id'] === signalId)) {
      outputItems.push(markSynthesized(chunk));
      continue;
    }

    // Merged into a reconciled item — strike through original, mark synthesized
    outputItems.push(markSynthesized(chunk));
  }

  // Insert reconciled items after the preamble/first section
  const reconciledText = reconciledItems
    .filter((r) => !r.singlePassthrough)
    .map((r) => r.rawText)
    .join('\n');

  // Build final content: preamble + reconciled + original items
  let result = preamble;
  if (reconciledText.trim()) {
    result += '\n' + reconciledText + '\n';
  }
  result += outputItems.join('');

  return result;
}

/**
 * Mark an INBOX item as superseded (strike through heading, update meta).
 */
function markSuperseded(itemText, signalId, sup) {
  const now = new Date().toISOString();

  // Strike through the heading line
  const lines = itemText.split('\n');
  lines[0] = lines[0].replace(/^(### )(.*)$/, (_, prefix, title) => {
    // Avoid double-striking
    return title.startsWith('~~') ? lines[0] : `${prefix}~~${title}~~`;
  });

  // Update Status line if present
  let text = lines.join('\n');
  text = text.replace(/\*\*Status:\*\* Open/, '**Status:** Superseded');

  // Append superseded info to Meta block or add new Meta block
  const supersededLines = `- [synthesized: true]\n- [superseded-by: ${sup.superseded_by}]\n- [superseded-at: ${now}]`;

  if (text.includes('**Meta:**')) {
    text = text.replace('- [synthesized: false]', `- [synthesized: true]`);
    // Append after last meta line
    text = text.replace(/((?:\n- \[[^\]]+\])+)(\s*\n|$)(?=\n*(?:###|$))/,
      (match) => match.trimEnd() + `\n- [superseded-by: ${sup.superseded_by}]\n- [superseded-at: ${now}]\n`);
  } else {
    text = text.trimEnd() + `\n**Superseded by:** ${sup.superseded_by} (${sup.reason})\n**Meta:**\n- [source: x-post]\n- [signal-id: ${signalId}]\n- [synthesized: true]\n- [superseded-by: ${sup.superseded_by}]\n- [superseded-at: ${now}]\n`;
  }

  return text;
}

/**
 * Mark an INBOX item as synthesized (update [synthesized: false] → true).
 */
function markSynthesized(itemText) {
  return itemText.replace('- [synthesized: false]', '- [synthesized: true]');
}

// ─── Atomic Write ─────────────────────────────────────────────────────────────

function writeAtomic(filePath, content) {
  const tmpPath = filePath + '.synth.tmp';
  // Clean up any stale tmp from previous crash
  try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// ─── File Lock ────────────────────────────────────────────────────────────────

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const pid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8'), 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0); // Throws if PID not alive
          log(`[signal-synthesizer] Lock held by PID ${pid} — cannot acquire`);
          return false;
        } catch {
          // Stale lock — process dead
          log(`[signal-synthesizer] Stale lock (PID ${pid} dead) — removing`);
          fs.unlinkSync(LOCK_PATH);
        }
      }
    }
    fs.writeFileSync(LOCK_PATH, String(process.pid), 'utf8');
    return true;
  } catch (err) {
    log(`[signal-synthesizer] Lock acquire error: ${err.message}`);
    return false;
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch {}
}

// ─── PRIORITIES.md Parser ─────────────────────────────────────────────────────

function parseInProgressItems(content) {
  const items = [];
  // Look for lines with "in-progress" or "In Progress" status near a bullet/heading
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    if (line.includes('in-progress') || line.includes('in progress')) {
      // Grab the heading or bullet text nearby
      for (let j = Math.max(0, i - 3); j <= i; j++) {
        const l = lines[j].trim();
        if (l.startsWith('#') || l.startsWith('-') || l.startsWith('*')) {
          const clean = l.replace(/^[#\-*]+\s*/, '').replace(/\*\*/g, '').trim();
          if (clean.length > 5) items.push(clean);
          break;
        }
      }
    }
  }
  return [...new Set(items)];
}

// ─── Heartbeat State ──────────────────────────────────────────────────────────

function updateHeartbeatState(runLog) {
  try {
    let state = {};
    if (fs.existsSync(HB_STATE)) {
      try { state = JSON.parse(fs.readFileSync(HB_STATE, 'utf8')); } catch {}
    }
    state.lastSignalSynthesis = {
      timestamp:        runLog.timestamp,
      run_id:           runLog.run_id,
      items_processed:  runLog.input_signals.length,
      items_output:     runLog.output_items,
      items_superseded: runLog.items_superseded,
    };
    state.pendingSignalCount = 0;
    writeAtomic(HB_STATE, JSON.stringify(state, null, 2));
  } catch (err) {
    log(`[signal-synthesizer] Heartbeat state update failed: ${err.message}`);
  }
}

// ─── Run Log ──────────────────────────────────────────────────────────────────

function appendRunLog(entry) {
  try {
    if (!fs.existsSync(path.dirname(RUNS_LOG))) {
      fs.mkdirSync(path.dirname(RUNS_LOG), { recursive: true });
    }
    // Remove internal flags before logging
    const { _update, _deferral_warning, ...logEntry } = entry;
    if (_deferral_warning) logEntry.warning = 'max_deferrals_reached';
    fs.appendFileSync(RUNS_LOG, JSON.stringify(logEntry) + '\n', 'utf8');
  } catch (err) {
    log(`[signal-synthesizer] Run log append failed: ${err.message}`);
  }
}

// ─── Slack Notification ───────────────────────────────────────────────────────

async function notifyPatrick(reconciledItems, supersededIds, runLog) {
  try {
    const inputCount      = runLog.input_signals.length;
    const outputCount     = reconciledItems.filter((r) => !r.singlePassthrough).length;
    const supersededCount = supersededIds.length;
    const unchangedCount  = runLog.items_unchanged;

    const reconciledLines = reconciledItems
      .filter((r) => !r.singlePassthrough)
      .map((r) => {
        const prio    = r.priority  || 'P2';
        const title   = r.heading?.replace(/^### \[.*?\] \[SYNTH\] /, '') || 'Synthesized item';
        const signals = (r.sourceSignals || []).length;
        return `• [${prio}] ${title}\n  └ Merged from ${signals} signal${signals !== 1 ? 's' : ''}`;
      }).join('\n');

    const supersededLines = supersededIds
      .map((s) => `• ~~${s.signal_id}~~ → replaced by ${s.superseded_by} (${s.reason || 'newer signal'})`)
      .join('\n');

    const deferralWarning = runLog._deferral_warning
      ? `\n⚠️ _Ran after ${MAX_DEFERRALS} deferrals — agent was still active_` : '';

    let text = `🧬 *Signal Synthesis Complete* (${runLog.run_id})
${inputCount} signals → ${outputCount} outputs (${supersededCount} superseded, ${unchangedCount} unchanged)${deferralWarning}`;

    if (reconciledLines) {
      text += `\n\n*Reconciled:*\n${reconciledLines}`;
    }

    if (supersededLines) {
      text += `\n\n*Superseded:*\n${supersededLines}`;
    }

    text += `\n\nFull details in INBOX.md`;

    const fs = require('fs');
    const path = require('path');
    const alertsFile = path.join(__dirname, '..', 'memory', 'pending-x-alerts.jsonl');
    fs.appendFileSync(alertsFile, JSON.stringify({ is_synthesis: true, text }) + '\n');
    log(`[signal-synthesizer] 📝 Queued Synthesis summary for 8:00 AM brief`);
    return true;
  } catch (err) {
    log(`[signal-synthesizer] ❌ Failed to queue synthesis summary: ${err.message}`);
    return false;
  }
}
}

async function slackSend(text) {
  const { spawnSync } = require('child_process');
  // Use spawnSync with args array (no shell) to safely handle LLM-generated text.
  // This avoids shell injection from backticks, $(), and other metacharacters that
  // a simple string-escape approach cannot fully cover.
  const result = spawnSync(
    'openclaw',
    ['message', 'send', '--channel', 'slack', '--target', SLACK_TARGET, '--message', text],
    { encoding: 'utf8', timeout: 15000 }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || `openclaw exited with status ${result.status}`);
  }
}

// ─── API Key Helper ───────────────────────────────────────────────────────────

function resolveAnthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const candidates = [
    '/opt/openclaw/.openclaw/agents/main/agent/auth-profiles.json',
    '/opt/openclaw/.openclaw/agents/developer/agent/auth-profiles.json',
    '/opt/openclaw/.openclaw/agents/researcher/agent/auth-profiles.json',
  ];
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue;
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const profiles = d.profiles || {};
      for (const key of ['anthropic:default', 'anthropic:manual']) {
        if (profiles[key]?.token) return profiles[key].token;
      }
    } catch {}
  }
  return null;
}

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`${ts} ${msg}`);
  try {
    const logFile = path.join(WORKSPACE, 'memory', 'alpha-router.log');
    fs.appendFileSync(logFile, `${ts} ${msg}\n`);
  } catch {}
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  resetDebounce,
  checkAndRunSynthesis,
  synthesize,
  // Exported for testing
  parsePendingSignals,
  clusterByArea,
  rebuildInbox,
  writeAtomic,
};
