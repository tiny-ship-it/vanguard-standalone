/**
 * Vanguard Load Tester
 * Simulation script for high-load cross-platform scenarios.
 */

const { runAssistantCoreTurn } = require('./loop');

async function simulateLoad(concurrentRequests = 10) {
    console.log(`[vanguard-tester] Starting simulation with ${concurrentRequests} concurrent requests...`);
    
    const tasks = Array.from({ length: concurrentRequests }).map((_, i) => {
        return runAssistantCoreTurn({
            userId: `sim-user-${i}`,
            message: `Simulated task ${i}: What is the status of Vanguard Knowledge Layer?`,
            sessionId: `sim-session-${i}`,
            channelId: `sim-channel-${i % 3}`,
            orgId: 'sim-org-1'
        });
    });

    const results = await Promise.allSettled(tasks);
    
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    console.log(`\n[vanguard-tester] Simulation Summary:`);
    console.log(`  Total: ${concurrentRequests}`);
    console.log(`  Success: ${succeeded}`);
    console.log(`  Failed: ${failed}`);

    if (failed > 0) {
        results.filter(r => r.status === 'rejected').forEach((r, i) => {
            console.error(`  Error ${i}: ${r.reason.message}`);
        });
    }
}

// Support running directly
if (require.main === module) {
    const count = parseInt(process.argv[2], 10) || 10;
    simulateLoad(count).catch(console.error);
}

module.exports = { simulateLoad };
