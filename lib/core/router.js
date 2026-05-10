/**
 * Vanguard Router (Formerly Vanguard Router)
 * Multi-tenant model routing engine with budget awareness, provider failover, and organizational pulse.
 */

const { selectModel, TASK_COMPLEXITY } = require('../model-selector');
const { callLlm } = require('../llm-client');
const memoryClient = require('../memory-client');
const { Pulsar } = require('./pulsar');

class Router {
    constructor(tenantId = 'system') {
        this.tenantId = tenantId;
        this.pulsar = new Pulsar();
        this.usageStats = {
            totalTokens: 0,
            costEstimate: 0,
            tierCounts: {}
        };
    }

    /**
     * Resolve the best model for a task, considering tenant constraints.
     * @param {string} taskPrompt - The user message or task description
     * @param {Object} options - selection options
     * @returns {string} Fully qualified model name
     */
    async resolve(taskPrompt, options = {}) {
        // 1. Resolve tenant UUID if necessary
        if (this.tenantId === 'system') {
            this.tenantId = memoryClient.SYSTEM_TENANT_ID;
        } else if (this.tenantId.includes('-') && this.tenantId.length < 32) {
            // Likely an external ID, resolve it
            const uuid = await memoryClient.resolveTenant(this.tenantId);
            if (uuid) this.tenantId = uuid;
        }

        // 2. Automatic Tier Selection if not provided
        let taskType = options.taskType;
        if (!taskType) {
            taskType = await this._classifyTask(taskPrompt);
        }

        // 2b. Organizational Pulse Check
        const urgencyMultiplier = await this.pulsar.getUrgencyMultiplier();
        if (urgencyMultiplier > 1.2 && (taskType === 'LEAF' || taskType === 'STANDARD')) {
            console.log(`[vanguard-router] High organizational friction detected (${urgencyMultiplier.toFixed(2)}x). Upgrading tier.`);
            taskType = taskType === 'LEAF' ? 'STANDARD' : 'SYNTHESIS';
        }

        // 3. Check Tenant Budget
        const budgetStatus = await this._getTenantBudgetStatus();
        
        let effectiveOptions = { ...options };
        
        if (budgetStatus.exhausted) {
            console.warn(`[vanguard-router] Budget exhausted for tenant ${this.tenantId}. Forcing LEAF tier.`);
            return selectModel('LEAF', effectiveOptions);
        }

        if (budgetStatus.constrained && (taskType === 'DEEP_REASONING' || taskType === 'SYNTHESIS')) {
            console.warn(`[vanguard-router] Budget constrained for tenant ${this.tenantId}. Downgrading ${taskType}.`);
            // selectModel handles 'cheap' budget by downgrading one tier
            effectiveOptions.budget = 'cheap';
        }

        // 4. Default to standard model-selector logic
        return selectModel(taskType, effectiveOptions);
    }

    /**
     * Use a lightweight model to classify task complexity
     */
    async _classifyTask(prompt) {
        try {
            const classificationPrompt = `Classify the following AI agent task into one of these tiers:
- LEAF: Simple data extraction, classification, summarization, or single-file reading.
- STANDARD: Coding tasks, research, tool orchestration, or multi-turn interaction.
- SYNTHESIS: Multi-source research synthesis, complex content assembly, or deep auditing.
- DEEP_REASONING: Architecture decisions, complex debugging across systems, or high-stakes strategy.

Output ONLY the tier name (LEAF, STANDARD, SYNTHESIS, or DEEP_REASONING).

Task: ${prompt.substring(0, 500)}`;

            const result = await callLlm({
                prompt: classificationPrompt,
                model: 'google/gemini-3-flash-preview',
                maxTokens: 20,
                temperature: 0.1
            });

            if (result) {
                const tier = result.trim().toUpperCase();
                if (TASK_COMPLEXITY[tier]) return tier;
            }
        } catch (err) {
            console.error(`[vanguard-router] Task classification failed: ${err.message}`);
        }
        return 'STANDARD'; // Default fallback
    }

    /**
     * Fetch the latest budget status from the Memory Engine
     */
    async _getTenantBudgetStatus() {
        try {
            // First check for an explicit budget status memory (kind: 'budget')
            const memories = await memoryClient.getRecentMemories(this.tenantId, {
                kind: 'budget',
                limit: 1
            });

            if (memories && memories.length > 0) {
                try {
                    return JSON.parse(memories[0].content);
                } catch (pErr) {
                    console.error(`[vanguard-router] Failed to parse budget memory: ${pErr.message}`);
                }
            }

            // If no specific budget status, check preferences for a limit
            const response = await fetch(`${memoryClient.MEMORY_ENGINE_URL}/preferences`, {
                headers: { 'X-Tenant-Id': this.tenantId }
            });
            
            if (response.ok) {
                const prefs = await response.json();
                if (prefs && prefs.budget_limit) {
                    return {
                        exhausted: false,
                        constrained: false,
                        limit: prefs.budget_limit,
                        current: 0.00,
                        currency: 'USD'
                    };
                }
            }
        } catch (err) {
            console.error(`[vanguard-router] Failed to fetch budget status: ${err.message}`);
        }

        // Default fallback if no budget memory or preference exists
        return {
            exhausted: false,
            constrained: false,
            limit: 100.00,
            current: 0.00,
            currency: 'USD'
        };
    }

    /**
     * Record usage after a task completes
     */
    async recordUsage(model, tokensIn, tokensOut) {
        try {
            const usageData = {
                model,
                tokens_in: tokensIn,
                tokens_out: tokensOut,
                timestamp: new Date().toISOString()
            };

            await memoryClient.storeMemory(this.tenantId, JSON.stringify(usageData), {
                kind: 'usage',
                source: 'vanguard-router'
            });

            // Local cache update
            this.usageStats.totalTokens += (tokensIn + tokensOut);
            console.log(`[vanguard-router] Recorded ${tokensIn + tokensOut} tokens for ${model} (Tenant: ${this.tenantId})`);
        } catch (err) {
            console.error(`[vanguard-router] Failed to record usage: ${err.message}`);
        }
    }
}


module.exports = {
    Router,
    TASK_COMPLEXITY
};
