'use strict';

/**
 * marker-blocks.js — managed markdown sections that self-heal.
 *
 * Lets writers (dreaming-cycle, heartbeat-executor, reflection passes)
 * update sections of MEMORY.md / USER.md / STATE.md without trampling
 * hand-written content. Inspired by Hermes's "managed block" convention
 * and OpenClaw's CHANGELOG mention of CRLF managed-block self-healing.
 *
 * Hermes-integration Week 1 (see projects/hermes-integration/SPEC.md §5.2).
 *
 * Block format:
 *   <!-- BEGIN managed:NAME written:ISO8601 owner:OWNER -->
 *   ...content (machine-managed)...
 *   <!-- END managed:NAME -->
 *
 * Rules:
 * - Two blocks with the same NAME → keep the one with the latest `written:` timestamp.
 * - Unmatched BEGIN with no END → log and skip.
 * - Never modify content outside BEGIN/END pairs.
 * - Atomic writes via `${path}.tmp` then rename.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BEGIN_RE = /^<!--\s*BEGIN managed:([\w.-]+)(?:\s+written:([\w:.+-]+))?(?:\s+owner:([\w.-]+))?\s*-->\s*$/;
const END_RE = /^<!--\s*END managed:([\w.-]+)\s*-->\s*$/;

/**
 * Parse all managed blocks in a markdown file.
 * @param {string} filePath
 * @returns {Array<{ name: string, owner: string|null, written: string|null, content: string, startLine: number, endLine: number }>}
 */
function readManagedBlocks(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const blocks = [];
  let open = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const beginMatch = line.match(BEGIN_RE);
    const endMatch = line.match(END_RE);

    if (beginMatch) {
      if (open) {
        // Unmatched previous BEGIN — discard, log to stderr
        process.stderr.write(
          `[marker-blocks] unmatched BEGIN at ${filePath}:${open.startLine + 1} (block "${open.name}")\n`,
        );
      }
      open = {
        name: beginMatch[1],
        written: beginMatch[2] || null,
        owner: beginMatch[3] || null,
        startLine: i,
        bodyLines: [],
      };
    } else if (endMatch) {
      if (!open || open.name !== endMatch[1]) {
        process.stderr.write(
          `[marker-blocks] unmatched END managed:${endMatch[1]} at ${filePath}:${i + 1}\n`,
        );
        continue;
      }
      blocks.push({
        name: open.name,
        owner: open.owner,
        written: open.written,
        content: open.bodyLines.join('\n'),
        startLine: open.startLine,
        endLine: i,
      });
      open = null;
    } else if (open) {
      open.bodyLines.push(line);
    }
  }

  if (open) {
    process.stderr.write(
      `[marker-blocks] BEGIN without END at ${filePath}:${open.startLine + 1} (block "${open.name}")\n`,
    );
  }

  return blocks;
}

/**
 * Insert or replace a managed block by name.
 * Preserves everything outside the block. Atomic write.
 *
 * @param {string} filePath
 * @param {{ name: string, owner?: string, content: string, written?: string }} block
 */
function upsertManagedBlock(filePath, block) {
  if (!block || !block.name) throw new Error('upsertManagedBlock: name required');
  if (typeof block.content !== 'string') throw new Error('upsertManagedBlock: content must be string');

  const written = block.written || new Date().toISOString();
  const owner = block.owner || 'unknown';
  const beginLine = `<!-- BEGIN managed:${block.name} written:${written} owner:${owner} -->`;
  const endLine = `<!-- END managed:${block.name} -->`;
  const newBlock = [beginLine, ...block.content.split('\n'), endLine].join('\n');

  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const lines = existing.split('\n');

  const blocks = readManagedBlocks(filePath);
  const sameName = blocks.filter((b) => b.name === block.name);

  if (sameName.length === 0) {
    // Append (with separating blank line if file isn't empty)
    const sep = existing.length > 0 && !existing.endsWith('\n\n') ? '\n\n' : '';
    atomicWrite(filePath, existing + sep + newBlock + '\n');
    return { action: 'inserted', name: block.name };
  }

  if (sameName.length > 1) {
    // Collapse: keep newest by `written`, remove all instances first
    const sorted = [...sameName].sort((a, b) => {
      const ta = a.written ? Date.parse(a.written) : 0;
      const tb = b.written ? Date.parse(b.written) : 0;
      return tb - ta;
    });
    const newest = sorted[0];
    // Build new lines array dropping all blocks with this name, then we'll add the new one.
    const toRemove = new Set();
    for (const b of sameName) {
      for (let i = b.startLine; i <= b.endLine; i++) toRemove.add(i);
    }
    const kept = lines.filter((_, i) => !toRemove.has(i));
    // Re-anchor: insert new block where the newest used to start (approximately).
    // Simple strategy: append to end. Original positions are lost anyway when collapsing.
    void newest; // explicit: we don't use position
    atomicWrite(filePath, kept.join('\n').replace(/\n+$/, '') + '\n\n' + newBlock + '\n');
    return { action: 'collapsed-and-updated', name: block.name, removed: sameName.length };
  }

  // Exactly one existing block — splice replace
  const existingBlock = sameName[0];
  const before = lines.slice(0, existingBlock.startLine);
  const after = lines.slice(existingBlock.endLine + 1);
  const out = [...before, newBlock, ...after].join('\n');
  atomicWrite(filePath, out);
  return { action: 'replaced', name: block.name };
}

/**
 * Remove a managed block by name. No-op if missing.
 * @param {string} filePath
 * @param {string} name
 */
function removeManagedBlock(filePath, name) {
  if (!fs.existsSync(filePath)) return { action: 'noop', reason: 'no-file' };
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const blocks = readManagedBlocks(filePath).filter((b) => b.name === name);
  if (blocks.length === 0) return { action: 'noop', reason: 'not-found' };
  const toRemove = new Set();
  for (const b of blocks) {
    for (let i = b.startLine; i <= b.endLine; i++) toRemove.add(i);
  }
  const kept = lines.filter((_, i) => !toRemove.has(i));
  atomicWrite(filePath, kept.join('\n'));
  return { action: 'removed', name, count: blocks.length };
}

/**
 * Atomic write to avoid partial files visible to readers.
 */
function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

// ─── Self-test (run with: node lib/marker-blocks.js) ─────────────────────────
if (require.main === module) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-blocks-'));
  const f = path.join(tmpDir, 'TEST.md');
  fs.writeFileSync(f, '# Manual content\n\nHand-written notes.\n');

  console.log('1. Insert');
  console.log(' ', upsertManagedBlock(f, { name: 'dream-2026-05-28', owner: 'dreaming-cycle', content: 'First dream entry.' }));

  console.log('2. Update (replace existing)');
  console.log(' ', upsertManagedBlock(f, { name: 'dream-2026-05-28', owner: 'dreaming-cycle', content: 'Updated dream entry.' }));

  console.log('3. Read');
  console.log(' ', readManagedBlocks(f).map((b) => ({ name: b.name, owner: b.owner, content: b.content.slice(0, 30) })));

  console.log('4. Manual content preserved?');
  const out = fs.readFileSync(f, 'utf8');
  console.log(' ', out.includes('Hand-written notes.') ? 'YES' : 'NO — REGRESSION');

  console.log('5. Remove');
  console.log(' ', removeManagedBlock(f, 'dream-2026-05-28'));

  console.log('6. Final file');
  console.log('---');
  console.log(fs.readFileSync(f, 'utf8'));
  console.log('---');

  fs.rmSync(tmpDir, { recursive: true });
  console.log('OK');
}

module.exports = { readManagedBlocks, upsertManagedBlock, removeManagedBlock };
