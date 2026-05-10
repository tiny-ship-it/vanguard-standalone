/**
 * Vanguard Platform Bridge
 * Bridge for cross-platform event listeners (Slack, Discord, Signal).
 */

const { runAssistantCoreTurn } = require('./loop');

class PlatformBridge {
    constructor(platform, config = {}) {
        this.platform = platform; // 'slack', 'discord', 'signal'
        this.config = config;
    }

    /**
     * Handle an inbound message event from any platform
     */
    async handleMessage(event) {
        const { userId, text, sessionId, channelId, orgId } = this._normalizeEvent(event);
        
        console.log(`[vanguard-bridge] Handling ${this.platform} message from ${userId} in ${channelId}...`);

        try {
            const response = await runAssistantCoreTurn({
                userId,
                message: text,
                sessionId,
                channelId,
                orgId
            });

            return this._formatResponse(response);
        } catch (err) {
            console.error(`[vanguard-bridge] Failed to handle message:`, err);
            return {
                text: "I encountered an error processing your request.",
                error: err.message
            };
        }
    }

    /**
     * Normalize platform-specific events into standard Vanguard format
     */
    _normalizeEvent(event) {
        switch (this.platform) {
            case 'slack':
                return {
                    userId: event.user,
                    text: event.text,
                    sessionId: event.thread_ts || event.ts,
                    channelId: event.channel,
                    orgId: event.team
                };
            case 'discord':
                return {
                    userId: event.author.id,
                    text: event.content,
                    sessionId: event.channelId,
                    channelId: event.channelId,
                    orgId: event.guildId
                };
            default:
                // Default fallback/Signal-like
                return {
                    userId: event.sender,
                    text: event.message,
                    sessionId: event.conversationId,
                    channelId: event.conversationId,
                    orgId: 'default'
                };
        }
    }

    /**
     * Format response back to platform-specific needs
     */
    _formatResponse(response) {
        // Handle flags from the loop (e.g. verification failures)
        let text = response.reply;
        if (response.flag === 'VERIFICATION_FAILED') {
            text += `\n\n⚠️ *Quality Note:* ${response.feedback}`;
        }

        return {
            text,
            status: response.status
        };
    }
}

module.exports = { PlatformBridge };
