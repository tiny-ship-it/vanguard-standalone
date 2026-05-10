/**
 * Vanguard Namespace Manager (Formerly Vanguard)
 * Handles hierarchical memory retrieval across multiple tenants/scopes with Identity-Aware Proxying.
 */

const { callLlm } = require('../llm-client');

class NamespaceManager {
    constructor(memoryClient) {
        this.memoryClient = memoryClient;
    }

    /**
     * Get combined context from multiple namespaces
     * @param {string} query 
     * @param {Object} namespaces - Map of namespace name to tenantId
     * @param {Object} sessionId - Optional session ID
     * @param {Object} options - { highSignal: boolean, identityProxy: boolean }
     * @returns {Promise<Object>}
     */
    async getUnifiedContext(query, namespaces, sessionId = null, options = {}) {
        const results = {};
        const promises = [];

        // Vanguard Prime Directive: Identity-Aware Proxying
        // If identityProxy is enabled, ensure we are filtering by user permissions.
        if (options.identityProxy) {
            console.log(`[vanguard-namespaces] Identity-Aware Proxying enabled for query: "${query.substring(0, 30)}..."`);
        }

        // 1. Semantic Check: Determine which namespaces are most relevant
        const plan = await this._planRetrieval(query, namespaces);
        console.log(`[vanguard-namespaces] Retrieval plan for "${query.substring(0, 30)}...":`, Object.keys(plan).filter(k => plan[k]));

        // 2. Query Enhancement (High Signal Mode)
        let enhancedQuery = query;
        if (options.highSignal) {
            enhancedQuery = await this._enhanceQuery(query);
            console.log(`[vanguard-namespaces] Enhanced query: ${enhancedQuery}`);
        }

        for (const [name, tenantId] of Object.entries(namespaces)) {
            if (!tenantId || !plan[name]) continue;
            
            if (name === 'personal') {
                promises.push(
                    this.memoryClient.getContext(tenantId, enhancedQuery, sessionId, {
                        includeLongTerm: true,
                        includeRecent: true,
                        includeSearch: true
                    }).then(async res => {
                        results[name] = res;
                    })
                );
            } else {
                // Search general memories
                promises.push(
                    this.memoryClient.searchMemories(tenantId, enhancedQuery, {
                        limit: 10,
                        minScore: 0.5
                    }).then(async memories => {
                        results[name] = await this._rerankMemories(query, memories);
                    })
                );

                // For project namespace, also fetch pending actionables
                if (name === 'project') {
                    promises.push(
                        this.memoryClient.getRecentMemories(tenantId, { limit: 10, kind: 'todo' })
                            .then(res => results.todos = res)
                    );
                    promises.push(
                        this.memoryClient.getRecentMemories(tenantId, { limit: 5, kind: 'blocker' })
                            .then(res => results.blockers = res)
                    );
                }
            }
        }

        await Promise.all(promises);
        return results;
    }

    /**
     * Use a lightweight LLM to generate a more effective search query
     */
    async _enhanceQuery(userQuery) {
        const prompt = `Convert the following user message into a high-signal search query for a vector database.
Focus on extracting key entities, technical terms, and core intent.

User Message: "${userQuery}"

Search Query:`;

        try {
            const response = await callLlm({
                prompt,
                model: 'google/gemini-3-flash-preview',
                maxTokens: 50,
                temperature: 0.2
            });
            return response.trim() || userQuery;
        } catch (err) {
            console.warn(`[vanguard-namespaces] Query enhancement failed: ${err.message}`);
            return userQuery;
        }
    }

    /**
     * Rerank retrieved memories using a specialist LLM, considering freshness and source.
     */
    async _rerankMemories(query, memories) {
        if (!memories || memories.length === 0) return [];
        
        // 1. Dedup by Source (keep only the most recent for each source file/doc)
        const dedupedBySource = [];
        const seenSources = new Set();
        
        // Sort by timestamp descending first
        const sortedByTime = [...memories].sort((a, b) => 
            new Date(b.event_at || b.created_at) - new Date(a.event_at || a.created_at)
        );

        for (const m of sortedByTime) {
            if (m.source && m.source !== 'direct' && m.source !== 'vanguard-router') {
                if (seenSources.has(m.source)) continue;
                seenSources.add(m.source);
            }
            dedupedBySource.push(m);
        }

        if (dedupedBySource.length <= 3) return dedupedBySource;
        
        // 2. LLM Reranking with Temporal Awareness
        const rerankPrompt = `Analyze these memories for relevance to the query: "${query}"
Rank them by technical relevance and freshness. Recent updates to project state or technical specs should be prioritized.

Return only the indices of the top 3 most relevant memories as a JSON array.

Memories:
${dedupedBySource.map((m, i) => `[${i}] (Source: ${m.source}, Date: ${m.event_at || m.created_at}) ${m.content.substring(0, 400)}`).join('\n')}

Response Format: [index1, index2, index3]`;

        try {
            const response = await callLlm({
                prompt: rerankPrompt,
                model: 'google/gemini-3-flash-preview',
                maxTokens: 100,
                temperature: 0
            });
            
            // Handle markdown code blocks and other minor JSON malformations from LLM
            let jsonString = response.replace(/```json/g, '').replace(/```/g, '').trim();
            const jsonMatch = jsonString.match(/\[[\d,\s,]+\]/);
            if (!jsonMatch) throw new Error(`Invalid response format: ${response}`);
            
            // Handle trailing commas
            jsonString = jsonMatch[0].replace(/,\s*\]/, ']');
            const indices = JSON.parse(jsonString);
            return indices.map(i => dedupedBySource[i]).filter(Boolean);
        } catch (err) {
            console.warn(`[vanguard-namespaces] Reranking failed: ${err.message}`);
            return dedupedBySource.slice(0, 3);
        }
    }

    /**
     * Use heuristics and lightweight LLM check to decide where to look.
     */
    async _planRetrieval(query, namespaces) {
        const lowerQuery = query.toLowerCase();
        const plan = {
            personal: true, // Default to true for continuity
            project: !!namespaces.project,
            global: true
        };

        // If it's a very specific personal query, maybe skip global?
        if (lowerQuery.includes('my ') || lowerQuery.includes(' I ') || lowerQuery.includes(' me ')) {
            // High personal relevance
        }

        // If it's a technical or general question, prioritize global
        const technicalKeywords = ['how to', 'what is', 'api', 'code', 'documentation', 'blender', 'sdk'];
        const isTechnical = technicalKeywords.some(k => lowerQuery.includes(k));
        
        if (isTechnical) {
            plan.global = true;
        }

        return plan;
    }

    /**
     * Format unified context for a prompt, applying distillation if necessary.
     */
    async formatContext(unifiedResults, options = {}) {
        const { maxChars = 10000 } = options;
        let output = "";
        
        // 1. Build prioritized context sections
        if (unifiedResults.personal) {
            output += `### Personal Context\n${unifiedResults.personal.context || 'None'}\n\n`;
        }

        if (unifiedResults.project && unifiedResults.project.length > 0) {
            output += `### Project/Team Context\n`;
            output += unifiedResults.project.map(m => `- ${m.content}`).join('\n');
            output += '\n\n';
        }

        if (unifiedResults.global && unifiedResults.global.length > 0) {
            output += `### Global/Shared Resources\n`;
            output += unifiedResults.global.map(m => `- ${m.content}`).join('\n');
            output += '\n\n';
        }

        // 2. Actionables (extracted from project namespace)
        if ((unifiedResults.todos && unifiedResults.todos.length > 0) || 
            (unifiedResults.blockers && unifiedResults.blockers.length > 0)) {
            output += `### Pending Actionables\n`;
            if (unifiedResults.blockers?.length > 0) {
                output += `#### BLOCKERS\n`;
                output += unifiedResults.blockers.map(m => `- [ ] ${m.content}`).join('\n');
                output += '\n';
            }
            if (unifiedResults.todos?.length > 0) {
                output += `#### TODOs\n`;
                output += unifiedResults.todos.map(m => `- [ ] ${m.content}`).join('\n');
                output += '\n';
            }
            output += '\n';
        }

        const trimmed = output.trim();

        // 2. Automated Context Compression
        if (trimmed.length > maxChars) {
            console.log(`[vanguard-namespaces] Context size (${trimmed.length}) exceeds threshold. Distilling...`);
            return await this.distillContext(trimmed, maxChars);
        }

        return trimmed;
    }

    /**
     * Distill large context into a high-signal summary
     */
    async distillContext(rawContext, targetChars) {
        const prompt = `Synthesize and compress the following AI agent context into a concise, high-signal summary.
Focus on:
- Active project state and blockers
- Key technical architectural decisions
- Recent relevant user interactions
- Crucial entities and identifiers

Target length: approximately ${Math.round(targetChars / 2)} characters.

Raw Context:
---
${rawContext}
---

High-Signal Summary:`;

        try {
            const response = await callLlm({
                prompt,
                model: 'google/gemini-3-flash-preview',
                maxTokens: 1000,
                temperature: 0.1
            });
            return `### Distilled Vanguard Context (Summarized)\n${response.trim()}`;
        } catch (err) {
            console.warn(`[vanguard-namespaces] Context distillation failed: ${err.message}`);
            return rawContext.substring(0, targetChars);
        }
    }
}

/**
 * Vanguard Identity-Aware Permission Proxy
 * (Placeholder for Phase 2 implementation)
 */
async function checkVanguardPermissions(userId, resourceId) {
    // TODO: Implement actual IAM/OAuth token proxying
    return true;
}

module.exports = {
    NamespaceManager,
    checkVanguardPermissions
};
