const { App } = require('@slack/bolt');
const { PlatformBridge } = require('../lib/core/bridge');
require('dotenv').config({ path: '/opt/openclaw/clawd/.env.joi' });

const bridge = new PlatformBridge('slack');

const app = new App({
  token: process.env.BOT_USER_AUTH_TOKEN,
  signingSecret: process.env.SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.APP_LEVEL_TOKEN,
  port: process.env.CORE_PORT || 3001
});

// Vanguard Routing
app.message(async ({ message, client, say }) => {
  // Ignore bot messages and sub-type messages (like join/leave)
  if (message.bot_id || message.subtype) return;

  console.log(`[Vanguard Bridge] Routing message from ${message.user} via Slack...`);

  try {
    const result = await bridge.handleMessage(message);
    
    await say({
      text: result.text,
      thread_ts: message.thread_ts || message.ts
    });
  } catch (err) {
    console.error(`[Vanguard Bridge] Error:`, err);
  }
});

(async () => {
  await app.start();
  console.log('🏗️ Vanguard Slack Bridge is active (Socket Mode).');
})();
