/**
 * Verification Script for Nango Integration
 */
const nangoConnector = require('./lib/connectors/nango');
const tenantResolver = require('./lib/tenant-resolver');
const packageJson = require('./package.json');
const fs = require('fs');
const path = require('path');

async function verify() {
  console.log('--- Vanguard Nango Integration Verification ---');

  // 1. Check package.json for @nangohq/node
  const hasNangoDep = !!packageJson.dependencies['@nangohq/node'];
  console.log(`[1] @nangohq/node in package.json: ${hasNangoDep ? 'PASS' : 'FAIL'}`);

  // 2. Check lib/connectors/nango.js exists
  const nangoPath = path.join(__dirname, 'lib/connectors/nango.js');
  const hasNangoFile = fs.existsSync(nangoPath);
  console.log(`[2] lib/connectors/nango.js exists: ${hasNangoFile ? 'PASS' : 'FAIL'}`);

  // 3. Test linking logic (Dry run/Unit test)
  console.log('[3] Verifying connectionId mapping logic...');
  const mockContext = {
    channel: {
      provider: 'slack',
      type: 'dm',
      userId: 'U09FF5JBXFW'
    }
  };

  const externalId = tenantResolver.extractExternalId(mockContext);
  console.log(`    External ID: ${externalId}`);

  // Note: We can't call resolveToUUID without actual network access to the Memory Engine
  // but we can verify the extractExternalId logic is correct for our connector.
  if (externalId === 'slack-U09FF5JBXFW') {
    console.log('    Linkage Logic: PASS (slack-U09FF5JBXFW extracted)');
  } else {
    console.log(`    Linkage Logic: FAIL (Got ${externalId})`);
  }

  // 4. Check trace file
  const tracePath = path.join(__dirname, 'harness/traces/nango-integration.json');
  const hasTraceFile = fs.existsSync(tracePath);
  console.log(`[4] harness/traces/nango-integration.json exists: ${hasTraceFile ? 'PASS' : 'FAIL'}`);

  // 5. Check README update
  const readmeContent = fs.readFileSync(path.join(__dirname, 'harness/README.md'), 'utf8');
  const hasReadmeUpdate = readmeContent.includes('Nango');
  console.log(`[5] harness/README.md updated: ${hasReadmeUpdate ? 'PASS' : 'FAIL'}`);

  if (hasNangoDep && hasNangoFile && hasTraceFile && hasReadmeUpdate) {
    console.log('\nVERIFICATION COMPLETE: ALL SYSTEMS GO 🫡');
    process.exit(0);
  } else {
    console.log('\nVERIFICATION FAILED: Check logs above.');
    process.exit(1);
  }
}

verify().catch(err => {
  console.error('Verification crashed:', err);
  process.exit(1);
});
