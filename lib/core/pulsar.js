/**
 * Vanguard Pulsar
 * Integrates Metropolis Heart signals into Vanguard routing and behavior.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const HEART_DB_PATH = '/opt/openclaw/clawd/vanguard-knowledge/heart/heart-signals.db';
const DUNBAR_DB_PATH = '/opt/openclaw/clawd/vanguard-knowledge/heart/dunbar-signals.db';

class Pulsar {
    constructor() {
        this.heartDb = null;
        this.dunbarDb = null;
        this._init();
    }

    _init() {
        try {
            if (fs.existsSync(HEART_DB_PATH)) {
                this.heartDb = new Database(HEART_DB_PATH, { readonly: true });
            }
            if (fs.existsSync(DUNBAR_DB_PATH)) {
                this.dunbarDb = new Database(DUNBAR_DB_PATH, { readonly: true });
            }
        } catch (err) {
            console.warn(`[vanguard-pulsar] Failed to connect to Heart signals: ${err.message}`);
        }
    }

    /**
     * Get aggregate health metrics for the organization
     */
    async getHealth() {
        if (!this.heartDb) return null;

        try {
            const stats = this.heartDb.prepare(`
                SELECT
                    AVG(avg_ttfr_min)    AS avgTtfr,
                    AVG(sentiment_score) AS avgSentiment,
                    SUM(thread_count)    AS activityVolume
                FROM daily_summary
            `).get();

            const topDunbar = this.dunbarDb ? this.dunbarDb.prepare(`
                SELECT AVG(dunbar_score) as avgScore FROM dunbar_scores
            `).get() : { avgScore: 0 };

            return {
                ttfr: stats.avgTtfr || 0,
                sentiment: stats.avgSentiment || 0,
                volume: stats.activityVolume || 0,
                dunbar: topDunbar.avgScore || 0,
                timestamp: new Date().toISOString()
            };
        } catch (err) {
            console.error(`[vanguard-pulsar] Error fetching health: ${err.message}`);
            return null;
        }
    }

    /**
     * Determine a Task Urgency Score (0-10) based on organizational pulse.
     * High TTFR or Low Sentiment = Higher Urgency.
     */
    async getUrgencyMultiplier() {
        const health = await this.getHealth();
        if (!health) return 1.0;

        let multiplier = 1.0;

        // TTFR > 60 mins is a signal of bottleneck
        if (health.ttfr > 60) multiplier += 0.2;
        if (health.ttfr > 120) multiplier += 0.3;

        // Sentiment < 0.2 is a signal of friction
        if (health.sentiment < 0.2) multiplier += 0.2;

        return Math.min(2.0, multiplier);
    }
}

module.exports = { Pulsar };
