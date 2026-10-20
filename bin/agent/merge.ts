// The controller's deterministic merge stops. A reviewer may add a stop, never remove one.
import { isDeepStrictEqual } from 'node:util';

export const DENY_RULES = [
  'repo',
  'ci',
  'deploy',
  'secrets',
  'auth',
  'money',
  'data',
  'dependency',
  'size',
] as const;
export type DenyRule = (typeof DENY_RULES)[number];

const SELF_GUARD = new Set([
  'bin/agent/merge.ts',
  'bin/agent/github.ts',
  'bin/agent/publish.ts',
  'bin/agent/result.ts',
  'agents/review.md',
  'agents/sdlc.md',
  'agents/contract.md',
  'agents/worker.md',
  'bin/agent/roles.ts',
  'bin/agent/run.ts',
  '.github/admission.txt',
]);

// GitHub's PR file list stops at 3000 entries, so a list that long may be incomplete.
export const FILE_LIST_CAP = 3000;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected a package object.');
  return value as Record<string, unknown>;
}

export function denyRules(
  repo: string,
  files: string[],
  pkgBase: string | null,
  pkgHead: string | null,
): DenyRule[] {
  const rules = new Set<DenyRule>();
  repo = repo.toLowerCase();
  if (repo === 'gingur-root/infra') rules.add('repo');
  for (const file of files) {
    const path = file.toLowerCase();
    const segments = path.split('/');
    const name = segments.at(-1)!;
    if (
      /^(\.github|actions|configs)\//.test(path) ||
      ['.node-version', '.prototools', 'pnpm-workspace.yaml'].includes(path) ||
      /^vite\.config\./.test(path)
    )
      rules.add('ci');
    if (
      /^pulumi[^/]*\.yaml$/.test(path) ||
      /^dockerfile/.test(name) ||
      /^compose.*\.y.*ml$/.test(name) ||
      /^wrangler\.[^/]*$/.test(path) ||
      ['vercel.json', 'netlify.toml', 'fly.toml'].includes(path) ||
      path.startsWith('.devkit/')
    )
      rules.add('deploy');
    if (
      path.includes('secret') ||
      name.startsWith('.env') ||
      /^\.gitleaks[^/]*$/.test(path) ||
      path === '.sops.yaml' ||
      /\.sops\./.test(name)
    )
      rules.add('secrets');
    if (
      segments.some((segment) => /^(auth|oauth|permission|identity|login|session)/.test(segment)) ||
      ['test/admission.test.ts', 'test/agent.token.test.ts'].includes(path) ||
      (repo === 'gingur-root/devkit' && SELF_GUARD.has(path))
    )
      rules.add('auth');
    if (segments.some((segment) => /billing|payment|stripe|invoice/.test(segment)))
      rules.add('money');
    if (
      segments.slice(0, -1).includes('migrations') ||
      name.endsWith('.sql') ||
      name === 'schema.prisma' ||
      segments.some((segment) => /^(e?mail|smtp)/.test(segment))
    )
      rules.add('data');
  }
  if (files.length >= FILE_LIST_CAP) rules.add('size');
  try {
    const base = pkgBase === null ? {} : object(JSON.parse(pkgBase));
    const head = pkgHead === null ? {} : object(JSON.parse(pkgHead));
    if (!isDeepStrictEqual(base.scripts, head.scripts)) rules.add('ci');
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const before = base[section] === undefined ? {} : object(base[section]);
      const after = head[section] === undefined ? {} : object(head[section]);
      if (
        Object.entries(after).some(
          ([key, version]) => typeof version !== 'string' || before[key] !== version,
        )
      )
        rules.add('dependency');
    }
  } catch {
    rules.add('dependency');
  }
  return DENY_RULES.filter((rule) => rules.has(rule));
}
