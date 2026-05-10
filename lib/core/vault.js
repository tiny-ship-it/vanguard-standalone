/**
 * Vanguard Vault
 * Multi-tenant memory management with scope-based isolation and sharing.
 */

const memoryClient = require('../memory-client');

class Vault {
    /**
     * @param {string} tenantId - The UUID of the primary tenant
     * @param {Object} context - Metadata about the current environment (channel, workspace)
     */
    constructor(tenantId, context = {}) {
        this.tenantId = tenantId;
        this.context = context; // { projectId, projectTenantId, orgId }
    }

    /**
     * Get isolated personal memory context
     */
    async getPersonalContext(query, sessionId) {
        return memoryClient.getContext(this.tenantId, query, sessionId, {
            includeLongTerm: true,
            includeRecent: true,
            includeSearch: true
        });
    }

    /**
     * Get shared project/team memory context
     */
    async getSharedContext(projectId, query) {
        const targetTenantId = this.context.projectTenantId;
        if (!targetTenantId) return null;
        
        return memoryClient.searchMemories(targetTenantId, query, {
            limit: 5,
            minScore: 0.7
        });
    }

    /**
     * Store a memory across multiple scopes if necessary
     */
    async store(content, options = {}) {
        const { scope = 'personal', ...rest } = options;
        
        let targetTenantId = this.tenantId;
        
        if (scope === 'project' && this.context.projectTenantId) {
            targetTenantId = this.context.projectTenantId;
        } else if (scope === 'workspace') {
            targetTenantId = memoryClient.SYSTEM_TENANT_ID; 
        }

        return memoryClient.storeMemoryWithDedup(targetTenantId, content, {
            ...rest,
            source: this.context.projectId ? `project-${this.context.projectId}` : 'direct'
        });
    }

    /**
     * Store a draft memory that can be reviewed before permanent storage
     */
    async storeDraft(content, options = {}) {
        return this.store(content, {
            ...options,
            kind: 'draft'
        });
    }

    /**
     * Record a decision with reasoning (Decision Memory)
     */
    async recordDecision(decision, reasoning, context = {}) {
        return this.store(`DECISION: ${decision}\nREASONING: ${reasoning}`, {
            kind: 'decision',
            ...context
        });
    }

    /**
     * Evolve conversation to long-term memory (Auto-distillation)
     */
    async distill(conversationText) {
        // 1. Core Learning Distillation
        const learningRes = await memoryClient.compressAndStore(this.tenantId, conversationText, {
            kind: 'learning'
        });

        // 2. Actionable Task & Blocker Extraction
        await this.extractActionables(conversationText);

        return learningRes;
    }

    /**
     * Extract structured tasks and blockers from conversation
     */
    async extractActionables(conversationText) {
        const { callLlm } = require('../llm-client');
        
        const prompt = `Analyze the following conversation and extract any PENDING TASKS (TODOs) or BLOCKERS.
A task is something that needs to be done. A blocker is something preventing progress.

Conversation:
---
${conversationText}
---

Format your response as a JSON object:
{
  "tasks": ["task 1", "task 2"],
  "blockers": ["blocker 1"]
}

Output ONLY the raw JSON object.`;

        try {
            const response = await callLlm({
                prompt,
                model: 'google/gemini-3-flash-preview',
                maxTokens: 1000,
                temperature: 0
            });

            const match = response.match(/\{.*\}/s);
            if (match) {
                const data = JSON.parse(match[0]);
                
                // Store tasks
                if (data.tasks && Array.isArray(data.tasks)) {
                    for (const task of data.tasks) {
                        await this.store(task, { 
                            kind: 'todo', 
                            source: 'session-extraction',
                            scope: this.context.projectTenantId ? 'project' : 'personal'
                        });
                    }
                }

                // Store blockers
                if (data.blockers && Array.isArray(data.blockers)) {
                    for (const blocker of data.blockers) {
                        await this.store(blocker, { 
                            kind: 'blocker', 
                            source: 'session-extraction',
                            scope: this.context.projectTenantId ? 'project' : 'personal'
                        });
                    }
                }
                
                console.log(`[vanguard-vault] Extracted ${data.tasks?.length || 0} tasks and ${data.blockers?.length || 0} blockers.`);
            }
        } catch (err) {
            console.warn(`[vanguard-vault] Failed to extract actionables: ${err.message}`);
        }
    }
}

module.exports = {
    Vault
};
