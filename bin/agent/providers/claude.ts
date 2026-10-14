import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { CLAUDE_SUBSCRIPTION_SOURCES, WEB_MCP_SERVERS } from '../constants.ts';
import type { Failure } from '../result.ts';
import type { Role } from '../roles.ts';
import {
  agentEnv,
  resolveExecutable,
  type RunInput,
  type RunOutput,
  stageDirs,
  statusFailure,
} from './shared.ts';

export function claudeOptions(
  role: Role,
  ctx: {
    cwd: string;
    executable: string;
    env: Record<string, string>;
    instructions: string;
    dirs?: string[];
    schema?: Record<string, unknown>;
  },
): Options {
  return {
    pathToClaudeCodeExecutable: ctx.executable,
    cwd: ctx.cwd,
    additionalDirectories: ctx.dirs,
    env: ctx.env,
    model: role.model,
    effort: role.effort,
    // No user, project or local settings, so no CLAUDE.md, hooks, plugins or
    // MCP servers from disk: only the role's own.
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: role.web
      ? Object.fromEntries(
          Object.entries(WEB_MCP_SERVERS).map(([name, url]) => [name, { type: 'http', url }]),
        )
      : {},
    // The allowlist is what actually removes subagents (Task), skills (Skill)
    // and the scheduling and messaging tools: an absent tool cannot be called.
    tools: [...role.tools, ...(role.web ? ['WebSearch', 'WebFetch'] : [])],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: ctx.instructions },
    outputFormat: ctx.schema && { type: 'json_schema', schema: ctx.schema },
  };
}
/**
 * Checks Claude's own report of what it loaded against what the role allows.
 * An MCP server's tools show up in `tools` as `mcp__…`, so this covers servers too.
 */
export function assertClaudeInit(
  init: { apiKeySource: string; tools: string[] },
  options: Options,
): void {
  if (!(CLAUDE_SUBSCRIPTION_SOURCES as readonly string[]).includes(init.apiKeySource)) {
    throw new Error(`Claude authenticated with ${init.apiKeySource}, not the subscription token.`);
  }
  const allowed = new Set(Array.isArray(options.tools) ? options.tools : []);
  // The SDK's own tool for returning the result when an output schema is set.
  if (options.outputFormat) allowed.add('StructuredOutput');
  const servers = Object.keys(options.mcpServers ?? {});
  const extra = init.tools.filter(
    (tool) => !allowed.has(tool) && !servers.some((name) => tool.startsWith(`mcp__${name}__`)),
  );
  if (extra.length)
    throw new Error(`Claude loaded tools the role does not allow: ${extra.join(', ')}`);
}

/**
 * The failure one message reports, if any. A rejected rate-limit event is the
 * only one that carries the reset time.
 */
export function claudeFailure(message: SDKMessage): Failure | undefined {
  if (message.type === 'rate_limit_event') {
    const { status, resetsAt } = message.rate_limit_info;
    if (status !== 'rejected') return undefined;
    // `resetsAt` is Unix seconds.
    return {
      class: 'rate_limit',
      resetsAt: resetsAt ? new Date(resetsAt * 1000).toISOString() : null,
    };
  }
  if (message.type === 'assistant' && message.error) {
    const { error } = message;
    const known = error === 'rate_limit' || error === 'overloaded' || error === 'server_error';
    return { class: known ? error : 'unknown', resetsAt: null };
  }
  if (message.type !== 'result') return undefined;
  if (message.subtype === 'error_max_turns') return { class: 'timeout', resetsAt: null };
  if (message.subtype === 'success' && message.is_error && message.api_error_status)
    return { class: statusFailure(message.api_error_status), resetsAt: null };
  return undefined;
}

export async function runClaude(input: RunInput): Promise<RunOutput> {
  const { role, prompt, emit } = input;
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const env = agentEnv('claude', process.env);
  const options = claudeOptions(role, {
    cwd: input.cwd,
    env,
    executable: resolveExecutable('claude', env.PATH),
    instructions: input.instructions,
    dirs: stageDirs(input),
    schema: input.schema,
  });
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), role.timeoutMinutes * 60_000);
  let ok = false;
  let result: unknown;
  let failure: Failure | undefined;
  let error: string | undefined;
  try {
    for await (const message of query({ prompt, options: { ...options, abortController } })) {
      const found = claudeFailure(message);
      // The rate-limit event wins, since it alone has the reset time.
      if (found && (!failure || message.type === 'rate_limit_event')) failure = found;
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
        if (message.subtype === 'success') result = message.structured_output;
        if (!ok)
          error =
            message.subtype === 'success'
              ? message.result
              : message.errors.join('; ') || message.subtype;
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
  } catch (thrown) {
    // The CLI can exit nonzero after reporting why, as on a rejected rate limit.
    if (abortController.signal.aborted) {
      failure = { class: 'timeout', resetsAt: null };
      error = `no result within ${role.timeoutMinutes} minutes`;
    } else {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    emit({ type: 'error', message: error });
  } finally {
    clearTimeout(timer);
  }
  return ok ? { ok, result } : { ok, result, failure, error };
}
