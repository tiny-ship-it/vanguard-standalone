const supervisor = require('../lib/core/supervisor');
const fs = require('fs');
const path = require('path');

async function testSupervisor() {
    console.log('🧪 Testing Vanguard Supervisor (Hermes Pattern)...');

    const activityPath = path.join(__dirname, '../memory/activity.jsonl');
    const statePath = path.join(__dirname, '../memory/supervisor-state.json');

    // Clean up
    if (fs.existsSync(activityPath)) fs.unlinkSync(activityPath);
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);

    // Mock some events
    const events = [
        {
            ts: new Date(Date.now() - 10000).toISOString(),
            agentId: 'maker',
            sessionId: 's1',
            outcome: 'success',
            output: 'Project implemented successfully.'
        },
        {
            ts: new Date(Date.now() - 5000).toISOString(),
            agentId: 'maker',
            sessionId: 's2',
            outcome: 'error',
            errorMessage: 'Rate limit exceeded on GitHub API'
        },
        {
            ts: new Date().toISOString(),
            agentId: 'maker',
            sessionId: 's3',
            outcome: 'timeout',
            duration_ms: 120000
        }
    ];

    fs.mkdirSync(path.dirname(activityPath), { recursive: true });
    fs.writeFileSync(activityPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');

    console.log('--- Running Supervision Cycle ---');
    const results = supervisor.run({ lookbackMs: 60000 });
    console.log('Results:', results);

    // Verify
    if (results.ack === 1 && results.retry === 1 && results.escalate === 1) {
        console.log('\n✅ SUPERVISOR TEST PASSED');
        console.log('   - s1: ACK (Success)');
        console.log('   - s2: RETRY (Rate limit error)');
        console.log('   - s3: ESCALATE (Timeout)');
    } else {
        console.log('\n❌ SUPERVISOR TEST FAILED');
        process.exit(1);
    }
}

testSupervisor().catch(err => {
    console.error(err);
    process.exit(1);
});
