#!/usr/bin/env node
/**
 * slack-full-extract.js
 * 
 * Joins all public Slack channels the bot can see, pulls full message history
 * from every channel (public + already-joined private), and writes structured
 * JSONL output to /mnt/data/slack-extraction/.
 * 
 * Output per channel: /mnt/data/slack-extraction/channels/{channel-id}.jsonl
 * Manifest:           /mnt/data/slack-extraction/manifest.json
 * User directory:     /mnt/data/slack-extraction/users.json
 * 
 * Usage: node scripts/slack-full-extract.js [--resume] [--channel <id>]
 *   --resume     Skip channels already fully extracted (uses manifest)
 *   --channel    Extract only a single channel (for testing)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// --- Config ---
const CONFIG_PATH = '/opt/openclaw/.openclaw/openclaw.json';
const GCS_BUCKET = 'gs://tinywins-knowledge-graph';
const GCS_PREFIX = 'slack-extraction';
// Local staging dir — small footprint, flushed to GCS after each channel
const STAGING_DIR = '/tmp/slack-extract-staging';
const OUT_DIR = '/mnt/data/slack-extraction/';
const CHANNELS_DIR = path.join(STAGING_DIR, 'channels');
const MANIFEST_PATH = path.join(STAGING_DIR, 'manifest.json');
const USERS_PATH = path.join(STAGING_DIR, 'users.json');
process.env.GOOGLE_APPLICATION_CREDENTIALS = '/opt/openclaw/clawd/.secrets/gcp-vertex-ai.json';

// Rate limit: Slack Tier 2 = 20 req/min for conversations.history
// We'll stay well under with 1.5s between channel requests, 0.5s between pages
const DELAY_BETWEEN_CHANNELS_MS = 1500;
const DELAY_BETWEEN_PAGES_MS = 500;

// --- Setup ---
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const BOT_TOKEN = config?.channels?.slack?.botToken;
if (!BOT_TOKEN) { console.error('No botToken found in config'); process.exit(1); }

const { execSync } = require('child_process');
fs.mkdirSync(STAGING_DIR, { recursive: true });
fs.mkdirSync(CHANNELS_DIR, { recursive: true });

// Upload a local file to GCS and delete it locally
function uploadToGCS(localPath, gcsPath) {
  execSync(`gsutil -q cp "${localPath}" "${GCS_BUCKET}/${gcsPath}"`, { stdio: 'inherit' });
  fs.unlinkSync(localPath);
}

// Write manifest to GCS (keep local copy for resume logic)
function saveManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  execSync(`gsutil -q cp "${MANIFEST_PATH}" "${GCS_BUCKET}/${GCS_PREFIX}/manifest.json"`, { stdio: 'pipe' });
}

const args = process.argv.slice(2);
const RESUME = args.includes('--resume');
const SINGLE_CHANNEL = args.includes('--channel') ? args[args.indexOf('--channel') + 1] : null;

// --- Helpers ---
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function slackRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const options = {
      hostname: 'slack.com',
      path: `/api/${method}${qs ? '?' + qs : ''}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            if (parsed.error === 'ratelimited') {
              const retryAfter = parseInt(res.headers['retry-after'] || '60', 10) * 1000;
              console.warn(`  ⏱ Rate limited. Waiting ${retryAfter / 1000}s...`);
              sleep(retryAfter).then(() => slackRequest(method, params).then(resolve).catch(reject));
              return;
            }
          }
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getAllChannels() {
  const channels = [];
  let cursor = '';
  do {
    const params = {
      types: 'public_channel,private_channel',
      limit: 200,
      exclude_archived: 'false',
      ...(cursor ? { cursor } : {})
    };
    const res = await slackRequest('conversations.list', params);
    if (!res.ok) { console.error('conversations.list error:', res.error); break; }
    channels.push(...(res.channels || []));
    cursor = res.response_metadata?.next_cursor || '';
    if (cursor) await sleep(DELAY_BETWEEN_PAGES_MS);
  } while (cursor);
  return channels;
}

async function getAllUsers() {
  const users = {};
  let cursor = '';
  do {
    const params = { limit: 200, ...(cursor ? { cursor } : {}) };
    const res = await slackRequest('users.list', params);
    if (!res.ok) { console.error('users.list error:', res.error); break; }
    for (const u of (res.members || [])) {
      users[u.id] = {
        id: u.id,
        name: u.name,
        real_name: u.real_name || u.profile?.real_name,
        display_name: u.profile?.display_name,
        title: u.profile?.title,
        is_bot: u.is_bot,
        deleted: u.deleted,
      };
    }
    cursor = res.response_metadata?.next_cursor || '';
    if (cursor) await sleep(DELAY_BETWEEN_PAGES_MS);
  } while (cursor);
  return users;
}

async function joinChannel(channelId) {
  const res = await slackRequest('conversations.join', { channel: channelId });
  return res.ok;
}

async function extractChannelHistory(channel) {
  const outPath = path.join(CHANNELS_DIR, `${channel.id}.jsonl`);
  const messages = [];
  let cursor = '';
  let pageCount = 0;

  do {
    const params = {
      channel: channel.id,
      limit: 200,
      ...(cursor ? { cursor } : {})
    };
    const res = await slackRequest('conversations.history', params);

    if (!res.ok) {
      if (res.error === 'not_in_channel') {
        console.warn(`  ⚠ Not in channel ${channel.name}, skipping`);
        return { status: 'skip', reason: 'not_in_channel', count: 0 };
      }
      if (res.error === 'channel_not_found') {
        return { status: 'skip', reason: 'channel_not_found', count: 0 };
      }
      console.error(`  ✗ Error fetching ${channel.name}:`, res.error);
      return { status: 'error', reason: res.error, count: 0 };
    }

    const batch = res.messages || [];
    messages.push(...batch);
    cursor = res.response_metadata?.next_cursor || '';
    pageCount++;

    if (cursor) await sleep(DELAY_BETWEEN_PAGES_MS);
  } while (cursor);

  // Also fetch thread replies for messages that have them
  const threaded = messages.filter(m => m.reply_count > 0);
  const threadReplies = [];
  for (const parent of threaded.slice(0, 200)) { // cap at 200 threads per channel
    const res = await slackRequest('conversations.replies', {
      channel: channel.id,
      ts: parent.ts,
      limit: 200,
    });
    if (res.ok && res.messages?.length > 1) {
      // First message is parent, rest are replies
      threadReplies.push(...res.messages.slice(1).map(m => ({ ...m, _thread_parent: parent.ts })));
    }
    await sleep(300);
  }

  // Timestamp helpers — all times stored as:
  //   ts_slack:   raw Slack epoch string (e.g. "1773267261.048689") — unique message ID
  //   ts_unix_ms: integer milliseconds since epoch — fast numeric sort/range queries
  //   ts_iso:     ISO 8601 UTC string — human-readable, joinable with Drive/Figma/Calendar
  //   ts_date:    YYYY-MM-DD — for day-level bucketing across sources
  function slackTsToMs(ts) {
    return ts ? Math.round(parseFloat(ts) * 1000) : null;
  }
  function slackTsToIso(ts) {
    const ms = slackTsToMs(ts);
    return ms ? new Date(ms).toISOString() : null;
  }
  function slackTsToDate(ts) {
    const iso = slackTsToIso(ts);
    return iso ? iso.slice(0, 10) : null;
  }

  // Write JSONL → stage locally → upload to GCS → delete local copy
  const stagingPath = path.join(STAGING_DIR, `${channel.id}.jsonl`);
  const allMessages = [...messages, ...threadReplies];
  const lines = allMessages.map(m => {
    const tsMs = slackTsToMs(m.ts);
    const threadTsMs = slackTsToMs(m.thread_ts);
    const editedTsMs = m.edited?.ts ? slackTsToMs(m.edited.ts) : null;

    return JSON.stringify({
      // --- Identity ---
      source: 'slack',
      channel_id: channel.id,
      channel_name: channel.name,
      message_id: m.ts,            // canonical Slack message ID (ts is the ID)
      user_id: m.user || null,
      bot_id: m.bot_id || null,

      // --- Timestamps (all four representations) ---
      ts_slack: m.ts,                            // raw Slack ts
      ts_unix_ms: tsMs,                          // numeric ms — use for sorting/ranging
      ts_iso: slackTsToIso(m.ts),               // ISO UTC — join with Drive/Figma
      ts_date: slackTsToDate(m.ts),             // YYYY-MM-DD — day bucketing

      // Thread timestamps
      thread_ts_slack: m.thread_ts || null,
      thread_ts_iso: slackTsToIso(m.thread_ts),
      thread_parent_id: m._thread_parent || null,
      reply_count: m.reply_count || 0,

      // Edit timestamps (important for tracking evolving decisions)
      edited_ts_iso: editedTsMs ? new Date(editedTsMs).toISOString() : null,
      edited_by: m.edited?.user || null,

      // --- Content ---
      text: m.text,
      subtype: m.subtype || null,
      reactions: m.reactions?.map(r => ({ name: r.name, count: r.count, users: r.users })) || [],
      files: m.files?.map(f => ({
        id: f.id,
        name: f.name,
        mimetype: f.mimetype,
        title: f.title,
        url: f.url_private,
        created: f.created ? new Date(f.created * 1000).toISOString() : null, // Drive links often embedded here
      })) || [],
      attachments: m.attachments?.map(a => ({
        title: a.title,
        title_link: a.title_link,   // URL of linked resource (Drive doc, Figma, etc)
        text: a.text,
        footer: a.footer,
        ts: a.ts ? new Date(a.ts * 1000).toISOString() : null,
      })) || [],
    });
  });

  fs.writeFileSync(stagingPath, lines.join('\n') + (lines.length ? '\n' : ''));
  // Upload to GCS: gs://tinywins-knowledge-graph/slack-extraction/channels/{id}.jsonl
  uploadToGCS(stagingPath, `${GCS_PREFIX}/channels/${channel.id}.jsonl`);
  return {
    status: 'ok',
    count: allMessages.length,
    pages: pageCount,
    gcs_path: `${GCS_BUCKET}/${GCS_PREFIX}/channels/${channel.id}.jsonl`,
  };
}

// --- Main ---
async function main() {
  console.log('🚀 TinyWins Slack Full Extraction');
  console.log(`📅 Started: ${new Date().toISOString()}`);
  console.log(`📁 Output: ${OUT_DIR}`);
  console.log(`🔄 Resume mode: ${RESUME}`);
  if (SINGLE_CHANNEL) console.log(`🎯 Single channel: ${SINGLE_CHANNEL}`);
  console.log('');

  // Load manifest (pull from GCS if resuming and not local)
  let manifest = {};
  if (RESUME && !fs.existsSync(MANIFEST_PATH)) {
    try {
      execSync(`gsutil -q cp "${GCS_BUCKET}/${GCS_PREFIX}/manifest.json" "${MANIFEST_PATH}"`, { stdio: 'pipe' });
      console.log('📥 Resumed manifest from GCS');
    } catch (_) { /* no prior run */ }
  }
  if (fs.existsSync(MANIFEST_PATH)) {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    console.log(`   Loaded manifest: ${Object.keys(manifest).length} prior channels\n`);
  }

  // Fetch users
  console.log('👥 Fetching user directory...');
  const users = await getAllUsers();
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
  execSync(`gsutil -q cp "${USERS_PATH}" "${GCS_BUCKET}/${GCS_PREFIX}/users.json"`, { stdio: 'pipe' });
  console.log(`   ${Object.keys(users).length} users saved → ${GCS_BUCKET}/${GCS_PREFIX}/users.json\n`);

  // Fetch all channels
  console.log('📋 Fetching channel list...');
  let channels = await getAllChannels();
  console.log(`   ${channels.length} total channels (${channels.filter(c => !c.is_private).length} public, ${channels.filter(c => c.is_private).length} private)\n`);

  if (SINGLE_CHANNEL) {
    channels = channels.filter(c => c.id === SINGLE_CHANNEL || c.name === SINGLE_CHANNEL);
  }

  // Stats
  let joined = 0, skipped = 0, errors = 0, totalMessages = 0;
  const failedChannels = [];

  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    const pct = Math.round((i / channels.length) * 100);

    // Skip if already done in resume mode
    if (RESUME && manifest[ch.id]?.status === 'ok') {
      console.log(`[${pct}%] ⏭ ${ch.name} (already extracted: ${manifest[ch.id].count} messages)`);
      totalMessages += manifest[ch.id].count || 0;
      skipped++;
      continue;
    }

    // Join if not a member
    if (!ch.is_member && !ch.is_private) {
      const joinResult = await joinChannel(ch.id);
      if (!joinResult) {
        console.log(`[${pct}%] ✗ Could not join ${ch.name}`);
        errors++;
        failedChannels.push(ch.name);
        continue;
      }
      await sleep(300);
    }

    console.log(`[${pct}%] 📥 ${ch.name} (${ch.is_private ? 'private' : 'public'})...`);
    const result = await extractChannelHistory(ch);

    manifest[ch.id] = {
      name: ch.name,
      is_private: ch.is_private,
      is_member: ch.is_member,
      // Channel creation time — useful for knowing when a project/client started
      created_unix_ms: ch.created ? ch.created * 1000 : null,
      created_iso: ch.created ? new Date(ch.created * 1000).toISOString() : null,
      extracted_at: new Date().toISOString(),
      ...result
    };

    // Save manifest after each channel (local + GCS)
    saveManifest(manifest);

    if (result.status === 'ok') {
      console.log(`   ✓ ${result.count} messages`);
      joined++;
      totalMessages += result.count;
    } else {
      console.log(`   ⚠ ${result.status}: ${result.reason}`);
      if (result.status === 'error') errors++;
    }

    await sleep(DELAY_BETWEEN_CHANNELS_MS);
  }

  // Final summary
  const summary = {
    completed_at: new Date().toISOString(),
    total_channels: channels.length,
    extracted: joined,
    skipped,
    errors,
    total_messages: totalMessages,
    failed_channels: failedChannels,
    output_dir: OUT_DIR,
  };

  const summaryPath = path.join(STAGING_DIR, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  execSync(`gsutil -q cp "${summaryPath}" "${GCS_BUCKET}/${GCS_PREFIX}/summary.json"`, { stdio: 'pipe' });

  console.log('\n✅ Extraction complete');
  console.log(`   Channels extracted: ${joined}`);
  console.log(`   Channels skipped: ${skipped}`);
  console.log(`   Errors: ${errors}`);
  console.log(`   Total messages: ${totalMessages.toLocaleString()}`);
  console.log(`   Output: ${OUT_DIR}`);

  return summary;
}

main().then(summary => {
  console.log('\nSummary:', JSON.stringify(summary, null, 2));
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
