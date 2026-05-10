/**
 * Tenant Context Resolver
 * Maps conversation context to Memory Engine tenant UUID
 *
 * TENANT HIERARCHY (priority order):
 * ===================================
 * 1. PERSONAL TENANT (DM context)
 *    - Direct messages with users
 *    - Uses pattern: `slack-{userId}`
 *    - Example: "slack-U09FF5JBXFW"
 *    - Each user gets their own isolated tenant
 *
 * 2. CHANNEL TENANT (mapped channels)
 *    - Specific channels with dedicated tenants
 *    - Uses pattern: `channel-{purpose}`
 *    - Example: "channel-tinywins-ai"
 *    - Defined in CHANNEL_TENANT_MAPPING
 *
 * 3. WORKSPACE TENANT (fallback)
 *    - All unmapped channels use workspace tenant
 *    - Uses pattern: `workspace-{teamId}`
 *    - Example: "workspace-T09FF5JBXFW"
 *    - Shared context for general channels
 *
 * @module tenant-resolver
 */

const MEMORY_ENGINE_URL = process.env.MEMORY_ENGINE_URL ||
  'https://memory-engine-230664305014.us-central1.run.app';

// Known tenant UUIDs
const SYSTEM_TENANT_UUID = 'c20f76e4-6e12-4da6-b5ba-c1cd3de5fc67';
const PATRICK_TENANT_UUID = '053a498b-5fde-45a7-93b5-197f096f037a';

/**
 * Channel Tenant Strategy: AUTO-CREATION
 * =======================================
 * Each Slack channel automatically gets its own tenant on first message.
 * No manual mapping needed!
 *
 * Pattern: slack-channel-{channelId}
 * Example: Channel C01234567 → external_id: "slack-channel-C01234567"
 *
 * When you're added to a new channel, the first message will:
 * 1. Extract channel ID from context (e.g., "C01234567")
 * 2. Generate external_id: "slack-channel-C01234567"
 * 3. Auto-create tenant if it doesn't exist
 * 4. All future messages in that channel use the same tenant
 *
 * Benefits:
 * - Zero configuration needed
 * - Works for any channel you're invited to
 * - Channel name changes don't affect tenant
 * - Automatic isolation per channel
 */

// Cache: external_id → { uuid, timestamp }
const tenantCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Extract external_id from conversation context
 * Implements the tenant hierarchy: Personal (DM) → Channel (mapped) → Workspace (fallback)
 *
 * @param {object} context - OpenClaw event context
 * @returns {string|null} External ID (e.g., "slack-U09FF5JBXFW", "channel-tinywins-ai", "workspace-T09FF5JBXFW")
 *
 * Example contexts and expected results:
 * =====================================
 * 1. DM Context:
 *    { channel: { provider: 'slack', type: 'dm', userId: 'U09FF5JBXFW' } }
 *    → "slack-U09FF5JBXFW" (personal tenant)
 *
 * 2. Mapped Channel:
 *    { channel: { provider: 'slack', type: 'channel', id: 'C_TINYWINS_AI', teamId: 'T09FF5JBXFW' } }
 *    → "channel-tinywins-ai" (channel tenant)
 *
 * 3. Unmapped Channel:
 *    { channel: { provider: 'slack', type: 'channel', id: 'C12345678', teamId: 'T09FF5JBXFW' } }
 *    → "workspace-T09FF5JBXFW" (workspace tenant)
 *
 * 4. Thread in DM:
 *    { channel: { provider: 'slack', type: 'dm', userId: 'U09FF5JBXFW' }, thread: { id: '1234567890.123456' } }
 *    → "slack-U09FF5JBXFW" (personal tenant, threads inherit from parent)
 */
function extractExternalId(context) {
  if (!context) return null;

  // HIERARCHY LEVEL 1: Personal Tenant (DM context)
  // ================================================
  // Check if this is a direct message
  if (context.channel?.provider === 'slack') {
    const channelType = context.channel.type;
    const userId = context.channel.userId || context.user?.id;

    // DM context → Personal tenant
    if (channelType === 'dm' || channelType === 'im' || channelType === 'mpim') {
      if (userId) {
        console.log(`[tenant-resolver] DM context detected → Personal tenant: slack-${userId}`);
        return `slack-${userId}`;
      }
    }

    // HIERARCHY LEVEL 2: Channel Tenant (auto-created per channel)
    // =============================================================
    // Each Slack channel gets its own tenant automatically
    // Uses pattern: slack-channel-{channelId}
    // Auto-created on first message to that channel
    const channelId = context.channel.id;
    if (channelType === 'channel' || channelType === 'group') {
      if (channelId) {
        const channelTenant = `slack-channel-${channelId}`;
        console.log(`[tenant-resolver] Channel detected → Channel tenant: ${channelTenant}`);
        return channelTenant;
      }

      // Fallback: Use workspace tenant if no channel ID available
      const teamId = context.channel.teamId || context.team?.id;
      if (teamId) {
        console.log(`[tenant-resolver] Channel without ID, fallback to workspace tenant: workspace-${teamId}`);
        return `workspace-${teamId}`;
      }
    }

    // Fallback: If we have a userId but couldn't determine channel type, use personal tenant
    if (userId) {
      console.log(`[tenant-resolver] Unknown channel type, fallback to personal tenant: slack-${userId}`);
      return `slack-${userId}`;
    }
  }

  // User-level context (CLI, Web)
  if (context.user?.provider === 'slack' && context.user?.id) {
    return `slack-${context.user.id}`;
  }

  if (context.user?.provider === 'cli') {
    const userId = context.user.id || context.user.email;
    if (userId) return `cli-${userId}`;
  }

  if (context.user?.provider === 'web') {
    const userId = context.user.id || context.user.email;
    if (userId) return `web-${userId}`;
  }

  // Parse from origin string (legacy support)
  const from = context.origin?.from || '';
  const slackMatch = from.match(/slack:([A-Z0-9]+)/i);
  if (slackMatch) return `slack-${slackMatch[1]}`;

  const userMatch = from.match(/user:([A-Z0-9]+)/i);
  if (userMatch) return `slack-${userMatch[1]}`;

  return null;
}

/**
 * Resolve external_id to tenant UUID (with caching)
 * @param {string} externalId - External ID (e.g., "slack-U09FF5JBXFW")
 * @returns {Promise<string|null>} Tenant UUID
 */
async function resolveToUUID(externalId) {
  if (!externalId) return null;

  // Check cache
  const cached = tenantCache.get(externalId);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.uuid;
  }

  try {
    // Lookup tenant by external_id
    const response = await fetch(
      `${MEMORY_ENGINE_URL}/tenants/${encodeURIComponent(externalId)}`
    );

    if (response.ok) {
      const tenant = await response.json();
      tenantCache.set(externalId, {
        uuid: tenant.id,
        timestamp: Date.now()
      });
      console.log(`[tenant-resolver] Resolved ${externalId} → ${tenant.id} (cached)`);
      return tenant.id;
    }

    if (response.status === 404) {
      // Tenant doesn't exist - create it
      const provider = externalId.split('-')[0] || 'unknown';
      const createResponse = await fetch(`${MEMORY_ENGINE_URL}/tenants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          external_id: externalId,
          provider: provider,
          display_name: null,
          email: null,
          timezone: 'UTC'
        })
      });

      if (createResponse.ok) {
        const newTenant = await createResponse.json();
        tenantCache.set(externalId, {
          uuid: newTenant.id,
          timestamp: Date.now()
        });
        console.log(`[tenant-resolver] Created tenant ${newTenant.id} for ${externalId}`);
        return newTenant.id;
      } else {
        const error = await createResponse.text();
        console.error(`[tenant-resolver] Failed to create tenant: ${createResponse.status} ${error}`);
        return null;
      }
    }

    console.error(`[tenant-resolver] Failed to lookup tenant ${externalId}: ${response.status}`);
    return null;

  } catch (error) {
    console.error(`[tenant-resolver] Resolution error for ${externalId}:`, error.message);
    return null;
  }
}

/**
 * Get tenant UUID for current context
 * Implements the full tenant hierarchy routing logic
 *
 * @param {object} context - OpenClaw event context
 * @param {object} options - { useSystem: boolean }
 * @returns {Promise<string|null>} Tenant UUID, or null if resolution fails (fails closed)
 *
 * Routing Logic:
 * ==============
 * 1. If options.useSystem → SYSTEM_TENANT_UUID (manual override)
 * 2. DM context → Personal tenant (slack-{userId})
 * 3. Mapped channel → Channel tenant (channel-{purpose})
 * 4. Unmapped channel → Workspace tenant (workspace-{teamId})
 * 5. No context or resolution failure → null (no implicit system fallback)
 *
 * Example flows:
 * ==============
 * DM from Patrick (U09FF5JBXFW):
 *   context → extractExternalId() → "slack-U09FF5JBXFW" → resolveToUUID() → "053a498b-..."
 *
 * Message in #tinywins-ai (C_TINYWINS_AI):
 *   context → extractExternalId() → "channel-tinywins-ai" → resolveToUUID() → "abc123-..."
 *
 * Message in #random (C12345678, team T09FF5JBXFW):
 *   context → extractExternalId() → "workspace-T09FF5JBXFW" → resolveToUUID() → "def456-..."
 *
 * No context (system task):
 *   context → extractExternalId() → null → SYSTEM_TENANT_UUID → "c20f76e4-..."
 */
async function getTenantForContext(context, options = {}) {
  // Force system tenant (manual override)
  if (options.useSystem) {
    console.log('[tenant-resolver] Using system tenant (manual override)');
    return SYSTEM_TENANT_UUID;
  }

  // Extract external ID from context (implements hierarchy logic)
  const externalId = extractExternalId(context);
  if (!externalId) {
    console.warn('[tenant-resolver] No external ID in context; skipping tenant assignment (no implicit system fallback)');
    return null;
  }

  // Resolve to UUID (creates tenant if doesn't exist)
  const uuid = await resolveToUUID(externalId);
  if (!uuid) {
    console.warn(`[tenant-resolver] Could not resolve ${externalId}; skipping tenant assignment (no implicit system fallback)`);
    return null;
  }

  console.log(`[tenant-resolver] Resolved context → ${externalId} → ${uuid}`);
  return uuid;
}

/**
 * Inject tenant UUID into MCP headers
 * @param {object} context - OpenClaw event context
 * @param {object} mcpHeaders - Existing MCP headers (will be mutated)
 * @param {object} options - { useSystem: boolean }
 * @returns {Promise<object>} Updated headers object
 */
async function injectTenantHeader(context, mcpHeaders = {}, options = {}) {
  const tenantUUID = await getTenantForContext(context, options);
  if (!tenantUUID) {
    console.warn('[tenant-resolver] No tenant UUID resolved; not injecting x-tenant-id header');
    return mcpHeaders;
  }
  mcpHeaders['x-tenant-id'] = tenantUUID;
  return mcpHeaders;
}

/**
 * Clear tenant cache (useful for testing)
 */
function clearCache() {
  tenantCache.clear();
  console.log('[tenant-resolver] Cache cleared');
}

/**
 * Get cache statistics
 * @returns {object} Cache stats
 */
function getCacheStats() {
  const now = Date.now();
  let expired = 0;
  let active = 0;

  for (const [externalId, entry] of tenantCache.entries()) {
    if ((now - entry.timestamp) >= CACHE_TTL_MS) {
      expired++;
    } else {
      active++;
    }
  }

  return {
    total: tenantCache.size,
    active,
    expired,
    ttl_seconds: CACHE_TTL_MS / 1000
  };
}

/**
 * Get channel tenant mapping (for inspection/debugging)
 * @returns {object} Current channel mappings
 */
function getChannelMappings() {
  return { ...CHANNEL_TENANT_MAPPING };
}

/**
 * Check if a channel ID is mapped to a specific tenant
 * @param {string} channelId - Slack channel ID
 * @returns {string|null} Tenant external_id or null if not mapped
 */
function getChannelTenant(channelId) {
  return CHANNEL_TENANT_MAPPING[channelId] || null;
}

module.exports = {
  // Core functions
  extractExternalId,
  resolveToUUID,
  getTenantForContext,
  injectTenantHeader,

  // Constants
  SYSTEM_TENANT_UUID,
  PATRICK_TENANT_UUID,
  MEMORY_ENGINE_URL,

  // Channel mapping utilities
  getChannelMappings,
  getChannelTenant,

  // Cache utilities
  clearCache,
  getCacheStats
};
