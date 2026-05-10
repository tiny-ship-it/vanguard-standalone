#!/usr/bin/env node

/**
 * Figma Frame Scraper
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads the `assets` table in vault/tenant-U09FF5JBXFW/brain-state.db,
 * finds rows with Figma file keys/versions, fetches PNG renderings via the
 * Figma REST API, and uploads them to GCS at:
 *   gs://tinywins-knowledge-graph/raw/figma/<file_key>/<node_id>.png
 *
 * ENV REQUIREMENTS:
 *   FIGMA_ACCESS_TOKEN   – Personal access token (or OAuth bearer)
 *   GOOGLE_APPLICATION_CREDENTIALS – Path to GCP service-account JSON
 *
 * USAGE:
 *   node scripts/figma-frame-scraper.js [--dry-run]
 *
 * METROPOLIS TARGET: Hands (Design-to-Code dataset)
 * SATURDAY SCOPE: MVP – download top-level frames only; no tree recursion.
 */

'use strict';

const path = require('path');
const { Storage } = require('@google-cloud/storage');
const { Pool } = require('pg');
const https = require('https');
const fs = require('fs');
const os = require('os');

// ─── Config ──────────────────────────────────────────────────────────────────
// Postgres (joi-metropolis-archive) — replaces local SQLite brain-state.db
const _joiEnvContent = fs.readFileSync(path.resolve(__dirname, '../.env.joi'), 'utf8');
const _joiEnv = {};
_joiEnvContent.split('\n').forEach(line => {
  const sep = line.indexOf(': ');
  if (sep !== -1) _joiEnv[line.slice(0, sep).trim()] = line.slice(sep + 2).trim();
});
const _pgPool = new Pool({
  host: _joiEnv.PG_HOST || '136.116.125.226',
  port: parseInt(_joiEnv.PG_PORT, 10) || 5432,
  user: _joiEnv.PG_USER || 'postgres',
  database: _joiEnv.PG_DATABASE || 'postgres',
  password: fs.readFileSync(path.resolve(__dirname, '../.secrets/joi-db-password'), 'utf8').trim(),
  max: 3,
  ssl: false,
});
const GCS_BUCKET = 'tinywins-knowledge-graph';
const GCS_PREFIX = 'raw/figma';
const FIGMA_API_BASE = 'https://api.figma.com/v1';
const FIGMA_TOKEN = process.env.FIGMA_ACCESS_TOKEN || (fs.existsSync(path.resolve(__dirname, '../.secrets/figma-pat.txt')) ? fs.readFileSync(path.resolve(__dirname, '../.secrets/figma-pat.txt'), 'utf8').trim() : null);
const DRY_RUN = process.argv.includes('--dry-run');
const CONCURRENCY = 4; // parallel frame downloads

// ─── Logging ─────────────────────────────────────────────────────────────────
const log = (level, msg, meta = {}) => {
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  console.log(JSON.stringify(entry));
};

// ─── HTTP helper (avoids heavy deps for Figma API calls) ─────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = { headers: { 'X-Figma-Token': FIGMA_TOKEN, ...headers } };
    https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, {}).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Figma API ────────────────────────────────────────────────────────────────
/**
 * Get the list of top-level frame node IDs from a Figma file.
 * Returns an array of { id, name } objects.
 */
async function getTopLevelFrames(fileKey) {
  const url = `${FIGMA_API_BASE}/files/${fileKey}?depth=2`;
  const { status, body } = await httpsGet(url);
  if (status !== 200) throw new Error(`Figma file fetch failed: ${status} for ${fileKey}`);
  const data = JSON.parse(body.toString('utf8'));
  const canvas = data.document?.children || [];
  const frames = [];
  for (const page of canvas) {
    for (const child of page.children || []) {
      if (child.type === 'FRAME' || child.type === 'COMPONENT' || child.type === 'SECTION') {
        frames.push({ id: child.id, name: child.name, page: page.name });
      }
    }
  }
  return frames;
}

/**
 * Fetch PNG image URLs for a batch of node IDs (Figma renders them server-side).
 * Returns a map: { nodeId → imageUrl }
 */
async function getImageUrls(fileKey, nodeIds, scale = 2) {
  const ids = nodeIds.join(',');
  const url = `${FIGMA_API_BASE}/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=png&scale=${scale}`;
  const { status, body } = await httpsGet(url);
  if (status !== 200) throw new Error(`Figma images API failed: ${status}`);
  const data = JSON.parse(body.toString('utf8'));
  if (data.err) throw new Error(`Figma images error: ${data.err}`);
  return data.images || {};
}

// ─── GCS upload ──────────────────────────────────────────────────────────────
async function uploadToGCS(storage, localPath, gcsPath) {
  const bucket = storage.bucket(GCS_BUCKET);
  await bucket.upload(localPath, { destination: gcsPath, resumable: false });
}

// ─── Concurrency helper ───────────────────────────────────────────────────────
async function pLimit(items, concurrency, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!FIGMA_TOKEN) {
    log('ERROR', 'FIGMA_ACCESS_TOKEN is not set. Aborting.');
    process.exit(1);
  }

  log('INFO', 'Starting Figma Frame Scraper', { dry_run: DRY_RUN, db: 'joi-metropolis-archive' });

  // 1. Read asset rows with Figma keys from Postgres (joi-metropolis-archive)
  const pgClient = await _pgPool.connect();
  let rows;
  try {
    const result = await pgClient.query(
      `SELECT id, url, figma_file_key, figma_version_id
       FROM assets
       WHERE figma_file_key IS NOT NULL AND figma_file_key != ''`
    );
    rows = result.rows;
  } finally {
    pgClient.release();
    await _pgPool.end();
  }

  // Deduplicate by file key (multiple asset rows may share the same file)
  const fileKeys = [...new Set(rows.map((r) => r.figma_file_key))];
  log('INFO', `Found ${rows.length} asset rows across ${fileKeys.length} unique Figma file(s)`);

  if (fileKeys.length === 0) {
    log('WARN', 'No Figma file keys found in assets table. Nothing to scrape.');
    return;
  }

  const storage = new Storage();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-'));

  let totalDownloaded = 0;
  let totalFailed = 0;

  for (const fileKey of fileKeys) {
    log('INFO', `Processing Figma file: ${fileKey}`);
    let frames;
    try {
      frames = await getTopLevelFrames(fileKey);
      log('INFO', `  Found ${frames.length} top-level frames`, { fileKey });
    } catch (err) {
      log('ERROR', `  Failed to list frames for ${fileKey}: ${err.message}`);
      totalFailed++;
      continue;
    }

    if (frames.length === 0) continue;

    // Batch node IDs (Figma API has a ~300-node limit per request)
    const BATCH_SIZE = 50;
    const batches = [];
    for (let b = 0; b < frames.length; b += BATCH_SIZE) {
      batches.push(frames.slice(b, b + BATCH_SIZE));
    }

    for (const batch of batches) {
      const nodeIds = batch.map((f) => f.id);
      let imageMap;
      try {
        imageMap = await getImageUrls(fileKey, nodeIds);
      } catch (err) {
        log('ERROR', `  Image URL fetch failed: ${err.message}`, { fileKey });
        totalFailed += batch.length;
        continue;
      }

      await pLimit(batch, CONCURRENCY, async (frame) => {
        const imageUrl = imageMap[frame.id];
        if (!imageUrl) {
          log('WARN', `  No image URL for frame ${frame.id} (${frame.name})`);
          return;
        }

        const safeFrameName = frame.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
        const fileName = `${frame.id}__${safeFrameName}.png`;
        const gcsPath = `${GCS_PREFIX}/${fileKey}/${fileName}`;
        const localFile = path.join(tmpDir, fileName);

        if (DRY_RUN) {
          log('DRY_RUN', `  Would upload ${gcsPath}`, { frame: frame.name, url: imageUrl });
          return;
        }

        try {
          // Download PNG from Figma CDN
          const { status, body } = await httpsGet(imageUrl);
          if (status !== 200) throw new Error(`CDN responded ${status}`);
          fs.writeFileSync(localFile, body);

          // Upload to GCS
          await uploadToGCS(storage, localFile, gcsPath);
          fs.unlinkSync(localFile);

          log('INFO', `  ✅ Uploaded gs://${GCS_BUCKET}/${gcsPath}`, {
            frame: frame.name,
            page: frame.page,
            bytes: body.length,
          });
          totalDownloaded++;
        } catch (err) {
          log('ERROR', `  ❌ Failed to process frame ${frame.id}: ${err.message}`);
          totalFailed++;
        }
      });
    }
  }

  // Cleanup temp dir
  try { fs.rmdirSync(tmpDir); } catch (_) {}

  log('INFO', 'Figma Frame Scraper complete', {
    downloaded: totalDownloaded,
    failed: totalFailed,
    dry_run: DRY_RUN,
  });

  if (totalFailed > 0) process.exit(1);
}

main().catch((err) => {
  log('ERROR', `Fatal: ${err.message}`, { stack: err.stack });
  process.exit(1);
});
