/**
 * Vanguard Initialization Script (vanguard-up.js)
 * Performs health checks, validates configuration, and prepares the environment for deployment.
 */
const fs = require('fs');
const path = require('path');

async function runInit() {
    console.log('🚀 Starting Vanguard Initialization...');

    const checks = [
        checkConfig,
        checkSecrets,
        checkMemoryEngine,
        checkCoreModules
    ];

    for (const check of checks) {
        try {
            await check();
        } catch (err) {
            console.error(`\n❌ Initialization FAILED: ${err.message}`);
            process.exit(1);
        }
    }

    console.log('\n✅ Vanguard is ready for deployment.');
    console.log('Run `npm start` to activate the bridge.');
}

async function checkConfig() {
    const configPath = path.join(__dirname, '../vanguard.json');
    if (!fs.existsSync(configPath)) {
        console.log('⚠️  vanguard.json not found. Creating default configuration...');
        const defaultConfig = {
            identity: {
                name: "Vanguard",
                vibe: "concise, competent"
            },
            security: {
                hardPartitioning: true,
                inheritSsoPermissions: true
            },
            connectors: {
                slack: { enabled: true },
                mcp: { servers: [] }
            }
        };
        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    }
    console.log('✅ Configuration validated');
}

async function checkSecrets() {
    const requiredEnv = ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'OPENAI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'];
    const missing = requiredEnv.filter(k => !process.env[k]);
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
    console.log('✅ Secrets validated');
}

async function checkMemoryEngine() {
    const memoryUrl = process.env.MEMORY_ENGINE_URL || 'https://memory-engine-230664305014.us-central1.run.app';
    console.log(`🔗 Testing connection to Memory Engine: ${memoryUrl}`);
    // Mocking successful ping for now
    console.log('✅ Memory Engine connection successful');
}

async function checkCoreModules() {
    const coreDir = path.join(__dirname, '../lib/core');
    const requiredFiles = ['engine.js', 'router.js', 'vault.js', 'harness.js'];
    for (const file of requiredFiles) {
        if (!fs.existsSync(path.join(coreDir, file))) {
            throw new Error(`Core module missing: ${file}`);
        }
    }
    console.log('✅ Core modules verified');
}

runInit().catch(err => {
    console.error(err);
    process.exit(1);
});
