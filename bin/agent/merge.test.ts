import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import { denyRules } from './merge.ts';

const repo = 'gingur-root/devkit';
const paths = {
  ci: [
    '.github/workflows/check.yml',
    'actions/verify/action.yml',
    'configs/vite.mjs',
    '.node-version',
    '.prototools',
    'pnpm-workspace.yaml',
    'vite.config.ts',
  ],
  deploy: [
    'Pulumi.prod.yaml',
    'Dockerfile',
    'app/Dockerfile.dev',
    'compose.yaml',
    'app/compose.prod.yml',
    'wrangler.toml',
    '.devkit/review.md',
  ],
  secrets: [
    'src/secrets.ts',
    '.env',
    'app/.env.local',
    '.gitleaks.toml',
    '.sops.yaml',
    'config/prod.sops.json',
  ],
  auth: [
    'src/auth.ts',
    'src/oauth/client.ts',
    'permissions/check.ts',
    'identity.ts',
    'login/page.ts',
    'session.ts',
    'test/admission.test.ts',
    'test/agent.token.test.ts',
    'bin/agent/merge.ts',
    'bin/agent/github.ts',
    'bin/agent/publish.ts',
    'bin/agent/result.ts',
    'agents/review.md',
    'agents/sdlc.md',
  ],
  money: ['billing.ts', 'src/payment/client.ts', 'src/mystripe.ts', 'src/invoice.ts'],
  data: [
    'migrations/001.ts',
    'src/migrations/001.ts',
    'query.sql',
    'db/query.sql',
    'schema.prisma',
    'db/schema.prisma',
  ],
};
for (const [rule, files] of Object.entries(paths)) {
  for (const file of files) {
    test(`${file} denies ${rule}, ignoring case`, () => {
      assert.deepEqual(denyRules(repo, [file], null, null), [rule]);
      assert.deepEqual(denyRules(repo.toUpperCase(), [file.toUpperCase()], null, null), [rule]);
    });
  }
}

test('safe paths pass; infra always stops; self-guard applies only to devkit', () => {
  assert.deepEqual(
    denyRules(repo, ['memory/devkit/fact.md', 'docs/readme.md', 'src/main.ts'], null, null),
    [],
  );
  assert.deepEqual(denyRules('gingur-root/infra', [], null, null), ['repo']);
  assert.deepEqual(denyRules('GINGUR-ROOT/INFRA', ['readme.md'], null, null), ['repo']);
  assert.deepEqual(
    denyRules('gingur-root/another', ['bin/agent/merge.ts', 'agents/review.md'], null, null),
    [],
  );
});

test('rules are unique and follow the table order', () => {
  assert.deepEqual(
    denyRules(
      'gingur-root/infra',
      [
        'db/schema.prisma',
        'src/payment/secret.ts',
        'src/auth.ts',
        'Dockerfile',
        '.github/x.yml',
        '.github/x.yml',
      ],
      '{}',
      '{"dependencies":{"new":"1"}}',
    ),
    ['repo', 'ci', 'deploy', 'secrets', 'auth', 'money', 'data', 'dependency'],
  );
  assert.deepEqual(denyRules(repo, ['.github/admission.txt'], null, null), ['ci', 'auth']);
});

for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  test(`${section} additions and changed versions stop; removals pass`, () => {
    const pkg = (value: unknown) => JSON.stringify({ [section]: value });
    assert.deepEqual(denyRules(repo, ['package.json'], null, pkg({ a: '1' })), ['dependency']);
    assert.deepEqual(denyRules(repo, ['package.json'], pkg({ a: '1' }), pkg({ a: '2' })), [
      'dependency',
    ]);
    assert.deepEqual(denyRules(repo, ['package.json'], pkg({ a: '1' }), '{}'), []);
    assert.deepEqual(
      denyRules(repo, ['package.json'], pkg({ a: '1', b: '2' }), pkg({ b: '2', a: '1' })),
      [],
    );
  });
}

test('dev dependencies pass, scripts stop, and malformed package text fails closed', () => {
  assert.deepEqual(denyRules(repo, ['package.json'], '{}', '{"devDependencies":{"test":"1"}}'), []);
  assert.deepEqual(
    denyRules(repo, ['package.json'], '{"scripts":{"test":"old"}}', '{"scripts":{"test":"new"}}'),
    ['ci'],
  );
  assert.deepEqual(
    denyRules(
      repo,
      ['package.json'],
      '{"scripts":{"a":"1","b":"2"}}',
      '{"scripts":{"b":"2","a":"1"}}',
    ),
    [],
  );
  assert.deepEqual(denyRules(repo, ['package.json'], '{"scripts":{"test":"old"}}', null), ['ci']);
  for (const invalid of ['{', 'null', '[]', '"text"']) {
    assert.deepEqual(denyRules(repo, ['package.json'], invalid, '{}'), ['dependency']);
    assert.deepEqual(denyRules(repo, ['package.json'], '{}', invalid), ['dependency']);
  }
});
