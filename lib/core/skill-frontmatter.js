'use strict';

/**
 * skill-frontmatter.js — agentskills.io-compatible skill scaffolding.
 *
 * Skills are markdown files with YAML frontmatter. The frontmatter is the
 * key: the agent reads it before loading the body, and decides whether the
 * skill is worth pulling into context. This directly attacks Tiny's silent
 * context-truncation pain — we stop injecting AGENTS.md / SKILL bodies
 * wholesale and instead select on metadata.
 *
 * Hermes-integration Week 1 scaffolding (see projects/hermes-integration/SPEC.md §5.4).
 * Week 2 cuts over lib/context-compactor.js to use this.
 *
 * Frontmatter schema (compatible with https://agentskills.io):
 *   ---
 *   name: skill-name                    (required)
 *   description: One-liner              (required, used for selection)
 *   when_to_use: [trigger phrases]      (optional, for keyword ranker)
 *   inputs: [{ name, description }]     (optional, for tool-call validation)
 *   outputs: [{ description }]          (optional)
 *   preconditions: [string]             (optional, agent checks before invoking)
 *   side_effects: read-only | writes-files | writes-memory | external-api
 *   trust: 0.0-1.0                      (SHIELD-aligned trust score)
 *   version: semver                     (optional)
 *   ---
 *
 *   # Body (only loaded when invoked)
 */

const fs = require('node:fs');
const path = require('node:path');

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

// Allowed side_effects values
const SIDE_EFFECTS = new Set(['read-only', 'writes-files', 'writes-memory', 'external-api']);

/**
 * Minimal YAML subset parser for skill frontmatter.
 * Supports: top-level scalars, top-level lists of scalars, top-level lists of single-line objects.
 * Does not support: nested mappings beyond one list-of-object level, anchors, multiline strings,
 * comments at end of line. Skills should keep their frontmatter simple.
 */
function parseYaml(src) {
  const out = {};
  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w]*)\s*:\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1];
    let val = kv[2];
    if (val === '') {
      // Possibly a list or block to follow on indented lines
      const items = [];
      i++;
      while (i < lines.length && /^\s+(- |\w+:)/.test(lines[i])) {
        const child = lines[i];
        const listItem = child.match(/^\s*-\s*(.*)$/);
        if (listItem) {
          const itemRaw = listItem[1];
          if (itemRaw.includes(': ')) {
            // object item: `- name: foo, description: bar` rendered as
            //   - name: foo
            //     description: bar
            // We support both shapes — single-line object via "{ k: v, k: v }" or
            // multi-key indented blocks (read until next `- ` at same indent or dedent).
            const obj = parseInlineObject(itemRaw);
            // Collect subsequent indented lines belonging to this item.
            const childIndent = child.match(/^(\s*)-/)[1].length + 2;
            let k = i + 1;
            while (k < lines.length) {
              const next = lines[k];
              if (next.trim() === '') {
                k++;
                continue;
              }
              const nextIndent = next.match(/^(\s*)/)[1].length;
              if (nextIndent < childIndent) break;
              if (next.match(/^\s*-\s/)) break;
              const childKv = next.match(/^\s*([A-Za-z_][\w]*)\s*:\s*(.*)$/);
              if (childKv) obj[childKv[1]] = parseScalar(childKv[2]);
              k++;
            }
            i = k;
            items.push(obj);
            continue;
          }
          items.push(parseScalar(itemRaw));
          i++;
        } else {
          // Inline mapping under a parent key (not a list) — skip; we don't support
          i++;
        }
      }
      out[key] = items;
      continue;
    }
    out[key] = parseScalar(val);
    i++;
  }
  return out;
}

function parseScalar(s) {
  const t = s.trim();
  if (t === '') return '';
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d*\.\d+$/.test(t)) return Number(t);
  // Strip optional surrounding quotes
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseInlineObject(s) {
  // Best-effort for `name: foo` single-key lines used as the first key of a multi-key item
  const m = s.match(/^([A-Za-z_][\w]*)\s*:\s*(.*)$/);
  if (!m) return { value: s };
  return { [m[1]]: parseScalar(m[2]) };
}

/**
 * Parse a single skill file.
 * @param {string} filePath
 * @returns {{ frontmatter: object, body: string, path: string, errors: string[] } | null}
 */
function parseSkill(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const src = fs.readFileSync(filePath, 'utf8');
  const m = src.match(FRONTMATTER_RE);
  if (!m) {
    return { frontmatter: {}, body: src, path: filePath, errors: ['no frontmatter'] };
  }
  const frontmatter = parseYaml(m[1]);
  const body = m[2];
  const errors = validateFrontmatter(frontmatter);
  return { frontmatter, body, path: filePath, errors };
}

function validateFrontmatter(fm) {
  const errors = [];
  if (!fm.name || typeof fm.name !== 'string') errors.push('name (string) is required');
  if (!fm.description || typeof fm.description !== 'string') errors.push('description (string) is required');
  if (fm.side_effects && !SIDE_EFFECTS.has(fm.side_effects)) {
    errors.push(`side_effects must be one of: ${[...SIDE_EFFECTS].join(', ')}`);
  }
  if (fm.trust != null && (typeof fm.trust !== 'number' || fm.trust < 0 || fm.trust > 1)) {
    errors.push('trust must be a number in [0, 1]');
  }
  return errors;
}

/**
 * Walk a directory tree, parsing every `*.md` whose filename is `SKILL.md` or under `skills/`.
 * @param {string} root
 * @returns {{ name: string, description: string, path: string, frontmatter: object, errors: string[] }[]}
 */
function indexSkills(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
        walk(p, depth + 1);
      } else if (ent.isFile() && (ent.name === 'SKILL.md' || /\.skill\.md$/.test(ent.name))) {
        const parsed = parseSkill(p);
        if (!parsed) continue;
        out.push({
          name: parsed.frontmatter.name || path.basename(path.dirname(p)),
          description: parsed.frontmatter.description || '',
          path: parsed.path,
          frontmatter: parsed.frontmatter,
          errors: parsed.errors,
        });
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Rank skills by frontmatter match against a free-text prompt. Keyword baseline
 * (the embedding-based ranker is a Week 2 deliverable). Cheap and deterministic.
 *
 * @param {Array} index   from indexSkills()
 * @param {string} prompt user input
 * @param {{ limit?: number, minScore?: number }} opts
 * @returns {Array<{ skill, score }>}
 */
function selectSkillsForContext(index, prompt, opts = {}) {
  const limit = opts.limit || 5;
  const minScore = opts.minScore || 0.1;
  const tokens = String(prompt || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  if (!tokens.length) return [];

  const scored = index.map((s) => {
    const haystack = [
      s.name,
      s.description,
      ...(Array.isArray(s.frontmatter.when_to_use) ? s.frontmatter.when_to_use : []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    let hits = 0;
    for (const tok of tokens) {
      if (haystack.includes(tok)) hits++;
    }
    return { skill: s, score: hits / tokens.length };
  });

  return scored
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ─── Self-test ───────────────────────────────────────────────────────────────
if (require.main === module) {
  const os = require('node:os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-fm-'));
  const skillDir = path.join(tmpDir, 'skills', 'send-slack');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---
name: send-slack
description: Post a message to a Slack channel
when_to_use:
  - User asks to send a Slack message
  - User says "post to slack"
inputs:
  - name: channel
    description: Slack channel ID or name
  - name: text
    description: Message body
outputs:
  - description: The message timestamp on success
preconditions:
  - SLACK_BOT_TOKEN is set
side_effects: external-api
trust: 1.0
version: 0.1.0
---

# send-slack

Posts a message to a Slack channel using the configured bot token.
`,
  );

  console.log('1. parseSkill');
  const parsed = parseSkill(path.join(skillDir, 'SKILL.md'));
  console.log(' ', JSON.stringify({ name: parsed.frontmatter.name, errors: parsed.errors }));

  console.log('2. indexSkills');
  const idx = indexSkills(tmpDir);
  console.log(' ', idx.length, 'skills found');

  console.log('3. selectSkillsForContext');
  console.log(' ', selectSkillsForContext(idx, 'please send a slack message to engineering', { limit: 3 }).map((r) => ({ name: r.skill.name, score: r.score })));

  console.log('4. validation catches missing name');
  fs.writeFileSync(path.join(tmpDir, 'bad.skill.md'), '---\ndescription: no name here\n---\n\nbody');
  const bad = parseSkill(path.join(tmpDir, 'bad.skill.md'));
  console.log(' ', bad.errors);

  fs.rmSync(tmpDir, { recursive: true });
  console.log('OK');
}

module.exports = { parseSkill, indexSkills, selectSkillsForContext, validateFrontmatter };
