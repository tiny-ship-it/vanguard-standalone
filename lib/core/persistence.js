/**
 * Vanguard Session Persistence
 * Manages serialized state for long-running tool operations.
 */

const { Vault } = require('./vault');

class SessionPersistence {
    constructor(vault) {
        this.vault = vault;
    }

    /**
     * Save the current session state
     * @param {string} sessionId - Unique session identifier
     * @param {Object} state - Serialized state object
     */
    async saveState(sessionId, state) {
        console.log(`[vanguard-persistence] Saving state for session ${sessionId}...`);
        return this.vault.store(JSON.stringify(state), {
            kind: 'session_state',
            sessionId: sessionId,
            timestamp: Date.now()
        });
    }

    /**
     * Load the most recent session state
     * @param {string} sessionId - Unique session identifier
     */
    async loadState(sessionId) {
        console.log(`[vanguard-persistence] Loading state for session ${sessionId}...`);
        
        // Use memory client to find the most recent session_state for this sessionId
        const memoryClient = require('../memory-client');
        const results = await memoryClient.searchMemories(this.vault.tenantId, `sessionId:${sessionId}`, {
            kind: 'session_state',
            limit: 1,
            sort: 'timestamp:desc'
        });

        if (results && results.length > 0) {
            try {
                return JSON.parse(results[0].content);
            } catch (err) {
                console.error(`[vanguard-persistence] Failed to parse session state: ${err.message}`);
                return null;
            }
        }

        return null;
    }

    /**
     * Clear session state
     */
    async clearState(sessionId) {
        console.log(`[vanguard-persistence] Clearing state for session ${sessionId}...`);
        // In a real memory client, we'd delete the records. 
        // For now, we'll store a null state or just rely on TTL/overwrites.
        return this.saveState(sessionId, null);
    }
}

module.exports = { SessionPersistence };
