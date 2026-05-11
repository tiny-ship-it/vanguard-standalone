const { extractExternalId } = require('./lib/tenant-resolver');

const tests = [
  {
    name: 'SSO Corporate Identity (User email)',
    context: {
      user: { email: 'matty@tinywins.com', provider: 'slack', id: 'U12345' }
    },
    expected: 'corporate-matty@tinywins.com'
  },
  {
    name: 'SSO Corporate Identity (SSO specific)',
    context: {
      user: { sso: { email: 'matty@tinywins.com' }, provider: 'web' }
    },
    expected: 'corporate-matty@tinywins.com'
  },
  {
    name: 'Legacy Slack DM (No Email)',
    context: {
      channel: { provider: 'slack', type: 'dm', userId: 'U12345' }
    },
    expected: 'slack-U12345'
  },
  {
    name: 'Slack Channel (No Email)',
    context: {
      channel: { provider: 'slack', type: 'channel', id: 'C99999' }
    },
    expected: 'slack-channel-C99999'
  }
];

console.log('--- Testing SSO & Permission Proxying Refactor ---');
let passed = 0;
tests.forEach(test => {
  const result = extractExternalId(test.context);
  if (result === test.expected) {
    console.log(`✅ [PASS] ${test.name}: ${result}`);
    passed++;
  } else {
    console.log(`❌ [FAIL] ${test.name}: Expected ${test.expected}, got ${result}`);
  }
});

console.log(`\nResults: ${passed}/${tests.length} passed.`);
if (passed === tests.length) {
  process.exit(0);
} else {
  process.exit(1);
}
