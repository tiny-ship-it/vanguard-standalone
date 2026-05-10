#!/usr/bin/env node

/**
 * GitHub PR Extractor
 * ─────────────────────────────────────────────────────────────────────────────
 * Pulls historical Pull Request diffs and review comments from the
 * various repos and stages them in GCS for
 * fine-tuning the Metropolis "Hands" model.
 *
 * Output GCS layout:
 *   gs://tinywins-knowledge-graph/raw/github/<org>/<repo>/prs/<pr_number>/
 *     meta.json        – PR metadata (title, author, dates, labels, state)
 *     diff.patch       – Full unified diff
 *     comments.jsonl   – One review comment per line (JSONL)
 *     review_threads.jsonl – Inline code review threads
 *
 * ENV REQUIREMENTS:
 *   GITHUB_TOKEN                    – Personal access token (repo scope)
 *   GOOGLE_APPLICATION_CREDENTIALS – Path to GCP service-account JSON
 *
 * USAGE:
 *   node scripts/github-pr-extractor.js [--dry-run] [--since 2024-01-01]
 *
 * METROPOLIS TARGET: Hands (Creative Direction → Code Diff dataset)
 * SATURDAY SCOPE: MVP – all merged PRs since 2024-01-01, no branch filtering.
 */

'use strict';

const path = require('path');
const { Storage } = require('@google-cloud/storage');
const https = require('https');
const { Readable } = require('stream');

// ─── Config ──────────────────────────────────────────────────────────────────
const GCS_BUCKET = 'tinywins-knowledge-graph';
const GCS_PREFIX = 'raw/github';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DRY_RUN = process.argv.includes('--dry-run');
const SINCE_ARG = process.argv.find((a) => a.startsWith('--since='))?.split('=')[1] || '2024-01-01';
const SINCE_DATE = new Date(SINCE_ARG);
const GITHUB_ORG = 'tiny-ship-it';
const TARGET_REPOS = [
  // { org: GITHUB_ORG, repo: 'example-repo' },
  { org: GITHUB_ORG, repo: 'noblemachines' },
];
const PAGE_SIZE = 30; // PRs per API page
const CONCURRENCY = 3; // parallel PR detail fetches

// ─── Logging ─────────────────────────────────────────────────────────────────
const log = (level, msg, meta = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta }));

// ─── GitHub API helper ────────────────────────────────────────────────────────
function ghGet(path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tinywins-metropolis/1.0',
        ...extraHeaders,
      },
    };
    https.get(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          json: () => JSON.parse(body.toString('utf8')),
        });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Paginate a GitHub API list endpoint until we exhaust pages or exceed SINCE_DATE.
 */
async function paginateGH(buildPath, stopCondition) {
  const results = [];
  let page = 1;
  while (true) {
    const { status, body } = await ghGet(buildPath(page));
    if (status === 404) { log('WARN', `Repo not found: ${buildPath(1)}`); break; }
    if (status !== 200) throw new Error(`GitHub API ${status}: ${body.toString('utf8').slice(0, 200)}`);
    const items = JSON.parse(body.toString('utf8'));
    if (!items.length) break;
    let done = false;
    for (const item of items) {
      if (stopCondition && stopCondition(item)) { done = true; break; }
      results.push(item);
    }
    if (done) break;
    page++;
    // Respect rate-limit: crude delay between pages
    await new Promise((r) => setTimeout(r, 300));
  }
  return results;
}

// ─── Concurrency helper ───────────────────────────────────────────────────────
async function pLimit(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx).catch((err) => {
        log('ERROR', `Worker error: ${err.message}`);
        return null;
      });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── GCS upload helpers ───────────────────────────────────────────────────────
async function uploadBuffer(storage, buf, gcsPath, contentType = 'application/octet-stream') {
  const bucket = storage.bucket(GCS_BUCKET);
  const file = bucket.file(gcsPath);
  await new Promise((resolve, reject) => {
    const stream = file.createWriteStream({
      resumable: false,
      contentType,
      metadata: { cacheControl: 'no-cache' },
    });
    stream.on('error', reject);
    stream.on('finish', resolve);
    Readable.from(buf).pipe(stream);
  });
}

// ─── Per-PR extraction ────────────────────────────────────────────────────────
async function extractPR(storage, org, repo, pr) {
  const prNum = pr.number;
  const base = `${GCS_PREFIX}/${org}/${repo}/prs/${prNum}`;

  log('INFO', `  Processing PR #${prNum}: ${pr.title}`, { state: pr.state, org, repo });

  if (DRY_RUN) {
    log('DRY_RUN', `  Would write ${base}/{meta.json,diff.patch,comments.jsonl}`);
    return;
  }

  // 1. Meta
  const meta = {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    author: pr.user?.login,
    created_at: pr.created_at,
    merged_at: pr.merged_at,
    closed_at: pr.closed_at,
    base_branch: pr.base?.ref,
    head_branch: pr.head?.ref,
    labels: pr.labels?.map((l) => l.name) || [],
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
    url: pr.html_url,
    body: pr.body || '',
  };
  await uploadBuffer(
    storage,
    Buffer.from(JSON.stringify(meta, null, 2)),
    `${base}/meta.json`,
    'application/json'
  );

  // 2. Diff (.patch)
  try {
    const { status, body } = await ghGet(
      `/repos/${org}/${repo}/pulls/${prNum}`,
      { Accept: 'application/vnd.github.diff' }
    );
    if (status === 200) {
      await uploadBuffer(storage, body, `${base}/diff.patch`, 'text/plain');
    } else {
      log('WARN', `  Diff fetch ${status} for PR #${prNum}`);
    }
  } catch (err) {
    log('WARN', `  Diff error for PR #${prNum}: ${err.message}`);
  }

  // 3. Issue comments (top-level PR conversation)
  const issueComments = await paginateGH(
    (page) => `/repos/${org}/${repo}/issues/${prNum}/comments?per_page=${PAGE_SIZE}&page=${page}`,
    null
  );
  const issueJsonl = issueComments
    .map((c) =>
      JSON.stringify({
        type: 'issue_comment',
        id: c.id,
        author: c.user?.login,
        body: c.body,
        created_at: c.created_at,
        updated_at: c.updated_at,
      })
    )
    .join('\n');
  if (issueJsonl) {
    await uploadBuffer(
      storage,
      Buffer.from(issueJsonl),
      `${base}/comments.jsonl`,
      'application/x-ndjson'
    );
  }

  // 4. Review comments (inline code annotations)
  const reviewComments = await paginateGH(
    (page) =>
      `/repos/${org}/${repo}/pulls/${prNum}/comments?per_page=${PAGE_SIZE}&page=${page}`,
    null
  );
  const reviewJsonl = reviewComments
    .map((c) =>
      JSON.stringify({
        type: 'review_comment',
        id: c.id,
        author: c.user?.login,
        path: c.path,
        line: c.line || c.original_line,
        diff_hunk: c.diff_hunk,
        body: c.body,
        created_at: c.created_at,
        in_reply_to_id: c.in_reply_to_id || null,
      })
    )
    .join('\n');
  if (reviewJsonl) {
    await uploadBuffer(
      storage,
      Buffer.from(reviewJsonl),
      `${base}/review_threads.jsonl`,
      'application/x-ndjson'
    );
  }

  log('INFO', `  ✅ Staged PR #${prNum} → gs://${GCS_BUCKET}/${base}/`, {
    issue_comments: issueComments.length,
    review_comments: reviewComments.length,
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!GITHUB_TOKEN) {
    log('ERROR', 'GITHUB_TOKEN is not set. Aborting.');
    process.exit(1);
  }

  log('INFO', 'Starting GitHub PR Extractor', {
    repos: TARGET_REPOS.map((r) => `${r.org}/${r.repo}`),
    since: SINCE_DATE.toISOString(),
    dry_run: DRY_RUN,
  });

  const storage = new Storage();

  for (const { org, repo } of TARGET_REPOS) {
    log('INFO', `\n── Repo: ${org}/${repo} ──`);

    // List all merged PRs (desc by updated), stop once older than SINCE_DATE
    let prs;
    try {
      prs = await paginateGH(
        (page) =>
          `/repos/${org}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`,
        (pr) => pr.merged_at && new Date(pr.merged_at) < SINCE_DATE
      );
    } catch (err) {
      log('ERROR', `Failed to list PRs for ${org}/${repo}: ${err.message}`);
      continue;
    }

    // Filter to only merged PRs within window
    const merged = prs.filter(
      (pr) => pr.merged_at && new Date(pr.merged_at) >= SINCE_DATE
    );

    log('INFO', `Found ${merged.length} merged PRs since ${SINCE_ARG}`, { repo });

    // Fetch full details + diff + comments in parallel
    await pLimit(merged, CONCURRENCY, async (pr) => {
      // Enrich with additions/deletions (not present in list endpoint)
      try {
        const { status, body } = await ghGet(`/repos/${org}/${repo}/pulls/${pr.number}`);
        const detail = status === 200 ? JSON.parse(body.toString('utf8')) : pr;
        await extractPR(storage, org, repo, detail);
      } catch (err) {
        log('ERROR', `Failed PR #${pr.number}: ${err.message}`);
      }
    });
  }

  log('INFO', 'GitHub PR Extractor complete.');
}

main().catch((err) => {
  log('ERROR', `Fatal: ${err.message}`, { stack: err.stack });
  process.exit(1);
});
