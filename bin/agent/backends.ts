// One adapter per executor. Each takes an already-isolated configuration,
// streams its events as JSON lines, and returns whether the run succeeded.

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

import type { Executor } from './constants.ts';
import {
  agentEnv,
  assertClaudeInit,
  assertCodexHome,
  claudeOptions,
  codexHome,
  codexOptions,
} from './isolation.ts';
import type { Role } from './roles.ts';

export interface RunInput {
  role: Role;
  prompt: string;
  cwd: string;
  emit(event: Record<string, unknown>): void;
}

/** The runner's own install, so the SDKs never fetch or run a bundled binary. */
function resolveExecutable(name: Executor, path: string | undefined): string {
  for (const dir of (path ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not in this directory
    }
  }
  throw new Error(`${name} is not on PATH.`);
}

async function runClaude({ role, prompt, cwd, emit }: RunInput): Promise<boolean> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const env = agentEnv('claude', process.env);
  const options = claudeOptions(role, {
    cwd,
    env,
    executable: resolveExecutable('claude', env.PATH),
  });
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), role.timeoutMinutes * 60_000);
  let ok = false;
  try {
    for await (const message of query({ prompt, options: { ...options, abortController } })) {
      if (message.type === 'system' && message.subtype === 'init') {
        // Before the first model call completes, stop if anything unexpected loaded.
        assertClaudeInit(message, options);
        emit({
          type: 'init',
          model: message.model,
          apiKeySource: message.apiKeySource,
          tools: message.tools,
          mcpServers: message.mcp_servers,
        });
      } else if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') emit({ type: 'message', text: block.text });
          else if (block.type === 'tool_use') emit({ type: 'tool', name: block.name });
        }
      } else if (message.type === 'result') {
        ok = message.subtype === 'success' && !message.is_error;
        emit({
          type: 'result',
          subtype: message.subtype,
          ok,
          text: message.subtype === 'success' ? message.result : undefined,
          usage: message.usage,
          turns: message.num_turns,
        });
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return ok;
}

async function runCodex({ role, prompt, cwd, emit }: RunInput): Promise<boolean> {
  const { Codex } = await import('@openai/codex-sdk');
  const env = agentEnv('codex', process.env);
  assertCodexHome(codexHome(env));
  const options = codexOptions({ env, executable: resolveExecutable('codex', env.PATH) });
  const codex = new Codex(options);
  const thread = codex.startThread({
    model: role.executor === 'codex' ? role.model : undefined,
    modelReasoningEffort: role.effort,
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    webSearchMode: role.web ? 'live' : 'disabled',
  });
  const signal = AbortSignal.timeout(role.timeoutMinutes * 60_000);
  // Codex has no system-prompt option; the role's instructions lead the prompt.
  const { events } = await thread.runStreamed(`${role.instructions}\n\n${prompt}`, { signal });
  let ok = false;
  emit({ type: 'init', config: options.config });
  for await (const event of events) {
    if (event.type === 'item.completed') {
      const { item } = event;
      if (item.type === 'agent_message') emit({ type: 'message', text: item.text });
      else if (item.type === 'mcp_tool_call')
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
  return ok;
}

export const BACKENDS = { claude: runClaude, codex: runCodex } as const satisfies Record<
  Executor,
  (input: RunInput) => Promise<boolean>
>;
