/**
 * Vanguard Engine
 * The core multi-tenant engine for Vanguard.
 * Manages tenant context, memory namespaces, and routing.
 */

const { Router } = require('./router');
const { Vault } = require('./vault');
const { NamespaceManager } = require('./namespaces');
const { SPECIALISTS, getSpecialistPrompt } = require('./specialists');
const memoryClient = require('../memory-client');

class AssistantCoreEngine {
    constructor() {
        this.tenants = new Map();
        this.nsManager = new NamespaceManager(memoryClient);
    }

    /**
     * Resolve a full context for a request
     * @param {Object} rawContext - { userId, provider, channelId, threadId, orgId }
     */
    async resolveContext(rawContext) {
        const { userId, provider = 'slack', channelId, orgId } = rawContext;
        
        // 1. Resolve Primary Tenant (The User)
        const userExternalId = `${provider}-${userId}`;
        const tenantId = await memoryClient.resolveTenant(userExternalId);
        
        // 2. Resolve Project/Shared Tenant (The Channel or Org)
        let projectTenantId = null;
        if (channelId) {
            projectTenantId = await memoryClient.resolveTenant(`${provider}-channel-${channelId}`);
        } else if (orgId) {
            projectTenantId = await memoryClient.resolveTenant(`${provider}-org-${orgId}`);
        }

        return {
            tenantId,
            userId,
            projectTenantId,
            projectId: channelId || orgId,
            provider,
            // Additional config could be loaded here (tier, etc.)
            config: {
                tier: 'standard',
                features: ['memory', 'routing', 'tools']
            }
        };
    }

    /**
     * Create a harness instance for a specific request context
     */
    async createHarness(rawContext) {
        const engineInstance = this;
        const context = await this.resolveContext(rawContext);
        
        const vault = new Vault(context.tenantId, {
            projectId: context.projectId,
            projectTenantId: context.projectTenantId
        });
        
        const router = new Router(context.tenantId);
        
        return {
            context,
            vault,
            router,
            
            /**
             * Process a message through the vanguard stack
             */
            async execute(message, sessionId, options = {}) {
                const { role = 'LEAD' } = options;
                
                // 1. Fetch Context from multiple namespaces (Hierarchical)
                const namespaces = {
                    personal: context.tenantId,
                    project: context.projectTenantId,
                    global: memoryClient.SYSTEM_TENANT_ID
                };
                
                // 2. Route to best model
                const model = await router.resolve(message);

                // 3. High Signal Retrieval for non-trivial tasks
                const isSimple = model.includes('lite') || model.includes('nano');
                const unifiedResults = await engineInstance.nsManager.getUnifiedContext(message, namespaces, sessionId, {
                    highSignal: !isSimple
                });

                // 4. Construct System Prompt using Specialists
                const rolePrompt = getSpecialistPrompt(role);
                const formattedContext = await engineInstance.nsManager.formatContext(unifiedResults);
                
                const systemPrompt = `${rolePrompt}

Current Tenant: ${context.tenantId}
Project: ${context.projectId || 'Private'}

[Context from Vanguard Vault]
${formattedContext}
`;

                return {
                    model,
                    systemPrompt,
                    context
                };
            },
        };
    }
}

module.exports = {
    AssistantCoreEngine
};
