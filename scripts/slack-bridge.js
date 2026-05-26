const { App } = require('@slack/bolt');
const { PlatformBridge } = require('../lib/core/bridge');
const http = require('http');
require('dotenv').config({ path: '/opt/openclaw/clawd/.env.joi' });

const bridge = new PlatformBridge('slack');

const app = new App({
  token: process.env.BOT_USER_AUTH_TOKEN,
  signingSecret: process.env.SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.APP_LEVEL_TOKEN,
  port: process.env.CORE_PORT || 3001
});

// Health Check Server
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
healthServer.listen(process.env.HEALTH_PORT || 3002);

// Vanguard Routing
app.message(async ({ message, client, say }) => {
  // Ignore bot messages and sub-type messages (like join/leave)
  if (message.bot_id || message.subtype) return;

  console.log(`[Vanguard Bridge] Routing message from ${message.user} in channel ${message.channel} via Slack...`);

  try {
    const result = await bridge.handleMessage(message);
    
    await say({
      text: result.text,
      thread_ts: message.thread_ts || message.ts
    });
    
    console.log(`[Vanguard Bridge] Successfully responded to ${message.user}`);
  } catch (err) {
    console.error(`[Vanguard Bridge] Error handling message:`, err);
    try {
      await say({
        text: "I encountered an error processing your request. Our team has been notified.",
        thread_ts: message.thread_ts || message.ts
      });
    } catch (sErr) {
      console.error(`[Vanguard Bridge] Critical: Failed to send error message to user:`, sErr);
    }
  }
});

(async () => {
  try {
    await app.start();
    console.log('🏗️ Vanguard Slack Bridge is active (Socket Mode).');
    console.log(`🏥 Health check server listening on port ${process.env.HEALTH_PORT || 3002}`);
  } catch (err) {
    console.error('Failed to start Vanguard Slack Bridge:', err);
    process.exit(1);
  }
})();
