import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vite-plus/test';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);
type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  'continue-on-error'?: boolean;
  with?: Record<string, string>;
};
const workflow: { jobs: { start: { steps: Step[] } } } = parse(
  readFileSync(new URL('.github/workflows/agent.retro.yml', root), 'utf8'),
);

test('retro collects bounded log tails without losing colliding job names or stopping on a missing log', () => {
  const logs = workflow.jobs.start.steps.find((step) => step.name === 'Logs');
  assert.ok(logs?.run, 'retro must fetch failed job logs');
  const dir = mkdtempSync(join(tmpdir(), 'retro-logs-'));
  try {
    writeFileSync(
      join(dir, 'gh'),
      `#!/bin/bash
set -euo pipefail
if [[ "$*" == *"/runs/42/jobs?filter=latest&per_page=100"* ]]; then
  [[ "$*" == *"--paginate"* ]]
  printf '1\tbuild / Review\tvps-runner2\n2\tbuild---Review\tvps-runner3\n3\tmissing\tvps-runner4\n4\tafter missing\tvps-runner5\n'
else
  echo 'unsupported gh api invocation' >&2
  exit 1
fi
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, 'curl'),
      `#!/bin/bash
set -euo pipefail
[[ "$*" == '-fsSL -H @- https://api.github.com/repos/owner/run-repo/actions/jobs/'*'/logs' ]]
IFS= read -r header
[[ "$header" == 'Authorization: Bearer test-token' ]]
if [[ "$*" == *"/jobs/3/logs"* ]]; then
  echo 'log expired' >&2
  exit 1
else
  for ((i=1; i<=250; i++)); do echo "line $i"; done
  echo '429 Too Many Requests'
fi
`,
      { mode: 0o755 },
    );
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', logs.run], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        REPO: 'owner/run-repo',
        RUN: '42',
        GH_TOKEN: 'test-token',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /log expired/);
    const out = join(dir, 'agent/in/run/logs');
    const files = readdirSync(out);
    assert.equal(files.length, 3);
    const contents = files.map((file) => readFileSync(join(out, file), 'utf8'));
    for (const runner of ['vps-runner2', 'vps-runner3', 'vps-runner5'])
      assert.ok(contents.some((text) => text.includes(`runner: ${runner}\n`)));
    for (const text of contents) {
      assert.equal(text.trimEnd().split('\n').length, 202);
      assert.match(text, /line 52\n/);
      assert.match(text, /429 Too Many Requests\n$/);
      assert.doesNotMatch(text, /line 51\n/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retro scans logs before upload and a scan failure cannot be ignored', () => {
  const steps = workflow.jobs.start.steps;
  const logs = steps.findIndex((step) => step.name === 'Logs');
  const scan = steps.findIndex((step) => step.uses?.includes('/actions/secrets.scan@'));
  const upload = steps.findIndex((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.ok(logs >= 0 && scan > logs && upload > scan);
  assert.equal(steps[logs]?.['continue-on-error'], true);
  assert.equal(steps[scan]?.['continue-on-error'], undefined);
  assert.equal(steps[scan]?.if, undefined);
  assert.equal(steps[scan]?.with?.path, '${{ runner.temp }}/agent/in/run/logs');
  assert.equal(steps[upload]?.if, undefined);
});

test('secrets.scan selects directory or git mode and propagates scanner failure', () => {
  const action: { runs: { steps: Step[] } } = parse(
    readFileSync(new URL('actions/secrets.scan/action.yml', root), 'utf8'),
  );
  const scan = action.runs.steps.find((step) => step.name === 'Scan');
  assert.ok(scan?.run);
  const dir = mkdtempSync(join(tmpdir(), 'retro-scan-'));
  try {
    mkdirSync(join(dir, 'logs with spaces'));
    writeFileSync(join(dir, 'gitleaks'), '#!/bin/bash\nprintf "%s\\n" "$@"\nexit 1\n', {
      mode: 0o755,
    });
    for (const scanPath of ['', join(dir, 'logs with spaces')]) {
      const result: SpawnSyncReturns<string> = spawnSync(
        'bash',
        ['-euo', 'pipefail', '-c', scan.run],
        {
          encoding: 'utf8',
          env: {
            PATH: `${dir}:${process.env.PATH}`,
            SCAN_PATH: scanPath,
            LOG_OPTS: 'base..head',
            GITHUB_ACTION_PATH: '/trusted/action',
          },
        },
      );
      assert.equal(result.status, 1);
      assert.deepEqual(
        result.stdout.trimEnd().split('\n'),
        scanPath
          ? [
              'dir',
              '--redact',
              '--no-banner',
              '--config',
              '/trusted/action/gitleaks.toml',
              scanPath,
            ]
          : ['git', '--redact', '--no-banner', '--log-opts', 'base..head', '.'],
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every public Bitwarden secret ID is allowlisted for the log scan', () => {
  const config = readFileSync(new URL('actions/secrets.scan/gitleaks.toml', root), 'utf8');
  const patterns = [...config.matchAll(/'''([^']+)'''/g)].map(
    (match) => new RegExp(match[0].slice(3, -3)),
  );
  const ids = new Set<string>();
  for (const directory of ['actions/', '.github/workflows/']) {
    for (const file of readdirSync(new URL(directory, root), {
      recursive: true,
      withFileTypes: true,
    })) {
      // Test workflows hold placeholder IDs that never reach pipeline logs.
      if (!file.isFile() || !/\.ya?ml$/.test(file.name) || /\.test\.ya?ml$/.test(file.name))
        continue;
      const text = readFileSync(join(file.parentPath, file.name), 'utf8');
      for (const match of text.matchAll(
        /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?=\s*>\s*[A-Z_]+)/gi,
      )) {
        ids.add(match[0]);
        assert.ok(
          patterns.some((pattern) => pattern.test(match[0])),
          `${file.name}: ${match[0]}`,
        );
      }
    }
  }
  assert.ok(ids.size > 0, 'must check at least one public secret ID');
});
