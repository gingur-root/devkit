import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CodexOptions, SandboxMode } from '@openai/codex-sdk';

import { CODEX_FEATURES_OFF, CODEX_HOME_FORBIDDEN, CODEX_SUBSCRIPTION_MODE } from '../constants.ts';
import type { Role } from '../roles.ts';
import {
  agentEnv,
  type Env,
  resolveExecutable,
  type RunInput,
  type RunOutput,
  stageDirs,
} from './shared.ts';

function codexHome(env: Env): string {
  const home = env.CODEX_HOME ?? (env.HOME && join(env.HOME, '.codex'));
  if (!home) throw new Error('Neither CODEX_HOME nor HOME is set.');
  return home;
}

/**
 * The SDK cannot pass `--ignore-user-config`, so the Codex home must hold
 * nothing but the login, and the login must be ChatGPT. Only `auth_mode` is
 * read from auth.json; nothing from it is printed.
 */
export function assertCodexHome(home: string): void {
  const present = CODEX_HOME_FORBIDDEN.filter((file) => existsSync(join(home, file)));
  if (present.length)
    throw new Error(
      `${home} has ${present.join(', ')}; agent runs load config only from the role.`,
    );
  const auth = join(home, 'auth.json');
  let mode: unknown;
  try {
    mode = (JSON.parse(readFileSync(auth, 'utf8')) as { auth_mode?: unknown }).auth_mode;
  } catch {
    // JSON.parse quotes the text near the error, which here is a token.
    throw new Error(`Codex login in ${home} is missing or not readable JSON.`);
  }
  if (mode !== CODEX_SUBSCRIPTION_MODE)
    throw new Error(`Codex login in ${home} is not a ChatGPT login.`);
}

/** Codex has no tool allowlist, so the sandbox is the closest match to the role's tools. */
export function codexSandbox(tools: Role['tools']): SandboxMode {
  if (tools.includes('Bash')) return 'danger-full-access';
  if (tools.includes('Edit') || tools.includes('Write')) return 'workspace-write';
  return 'read-only';
}

export function codexOptions(ctx: {
  executable: string;
  env: Record<string, string>;
}): CodexOptions {
  return {
    codexPathOverride: ctx.executable,
    env: ctx.env,
    config: {
      features: Object.fromEntries(CODEX_FEATURES_OFF.map((feature) => [feature, false])),
      // `features.multi_agent` alone leaves the collaboration tools registered.
      agents: { enabled: false },
      // imagegen, openai-docs, skill-creator and skill-installer ship inside Codex.
      skills: { bundled: { enabled: false } },
      // No AGENTS.md from the repo, matching Claude's `settingSources: []`.
      project_doc_max_bytes: 0,
    },
  };
}

export async function runCodex(input: RunInput): Promise<RunOutput> {
  const { role, prompt, emit } = input;
  const { Codex } = await import('@openai/codex-sdk');
  const env = agentEnv('codex', process.env);
  assertCodexHome(codexHome(env));
  const options = codexOptions({ env, executable: resolveExecutable('codex', env.PATH) });
  const codex = new Codex(options);
  const thread = codex.startThread({
    model: role.model,
    modelReasoningEffort: role.effort,
    sandboxMode: codexSandbox(role.tools),
    approvalPolicy: 'never',
    workingDirectory: input.cwd,
    additionalDirectories: stageDirs(input),
    skipGitRepoCheck: true,
    webSearchMode: role.web ? 'live' : 'disabled',
  });
  const signal = AbortSignal.timeout(role.timeoutMinutes * 60_000);
  // Codex has no system-prompt option; the role's instructions lead the prompt.
  const { events } = await thread.runStreamed(`${input.instructions}\n\n${prompt}`, {
    signal,
    outputSchema: input.schema,
  });
  let ok = false;
  let last = '';
  emit({ type: 'init', config: options.config });
  for await (const event of events) {
    if (event.type === 'item.completed') {
      const { item } = event;
      if (item.type === 'agent_message') {
        last = item.text;
        emit({ type: 'message', text: item.text });
      } else if (item.type === 'mcp_tool_call')
        emit({ type: 'tool', name: `${item.server}.${item.tool}` });
      else if (item.type === 'command_execution')
        emit({ type: 'tool', name: 'exec', exit: item.exit_code });
      else if (item.type === 'error') emit({ type: 'error', message: item.message });
    } else if (event.type === 'turn.completed') {
      ok = true;
      emit({ type: 'result', ok, usage: event.usage });
    } else if (event.type === 'turn.failed') {
      emit({ type: 'result', ok: false, error: event.error.message });
    } else if (event.type === 'error') {
      emit({ type: 'error', message: event.message });
    }
  }
  // With an output schema, the final message is the result as JSON.
  return { ok, result: ok && input.schema ? JSON.parse(last) : undefined };
}
