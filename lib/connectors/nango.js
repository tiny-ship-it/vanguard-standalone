const { Nango } = require('@nangohq/node');
const tenantResolver = require('../tenant-resolver');

/**
 * Nango Connector for Vanguard
 * Integrates Nango's unified API for enterprise integrations.
 *
 * This wrapper ensures that Nango's connectionId is always linked
 * to Vanguard's tenantId (Memory Engine UUID).
 */
class NangoConnector {
  constructor() {
    this.secretKey = process.env.NANGO_SECRET_KEY || 'sk_test_dummy';
    if (!process.env.NANGO_SECRET_KEY) {
      console.warn('[nango-connector] NANGO_SECRET_KEY is not set; using dummy key for initialization');
    }
    this.nango = new Nango({ secretKey: this.secretKey });
  }

  /**
   * Get Nango connection for the current Vanguard context
   * @param {object} context - Vanguard context
   * @param {string} integrationId - Nango integration ID (e.g. 'slack', 'github')
   * @returns {Promise<object>} Nango connection metadata
   */
  async getConnection(context, integrationId) {
    const tenantId = await tenantResolver.getTenantForContext(context);
    if (!tenantId) {
      throw new Error('[nango-connector] Could not resolve tenantId from context');
    }

    // connectionId = Vanguard tenantId
    const connectionId = tenantId;

    try {
      console.log(`[nango-connector] Fetching connection for integration=${integrationId}, connectionId=${connectionId}`);
      return await this.nango.getConnection(integrationId, connectionId);
    } catch (error) {
      console.error(`[nango-connector] Error fetching connection: ${error.message}`);
      throw error;
    }
  }

  /**
   * List all connections for the current Vanguard context
   * @param {object} context - Vanguard context
   * @returns {Promise<Array>} List of Nango connections
   */
  async listConnections(context) {
    const tenantId = await tenantResolver.getTenantForContext(context);
    if (!tenantId) {
      throw new Error('[nango-connector] Could not resolve tenantId from context');
    }

    try {
      // Filter connections by connectionId (which is our tenantId)
      const connections = await this.nango.listConnections();
      return connections.filter(conn => conn.connectionId === tenantId);
    } catch (error) {
      console.error(`[nango-connector] Error listing connections: ${error.message}`);
      throw error;
    }
  }

  /**
   * Proxy request to Nango's Proxy API
   * @param {object} context - Vanguard context
   * @param {object} params - Nango proxy params (method, endpoint, integrationId, etc.)
   */
  async proxy(context, params) {
    const tenantId = await tenantResolver.getTenantForContext(context);
    if (!tenantId) {
      throw new Error('[nango-connector] Could not resolve tenantId from context');
    }

    const { method, endpoint, integrationId, data, headers } = params;

    try {
      return await this.nango.proxy({
        method,
        endpoint,
        integrationId,
        connectionId: tenantId,
        data,
        headers
      });
    } catch (error) {
      console.error(`[nango-connector] Proxy request failed: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new NangoConnector();
