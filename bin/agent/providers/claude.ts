import type { Options } from '@anthropic-ai/claude-agent-sdk';

import { CLAUDE_SUBSCRIPTION_SOURCES } from '../constants.ts';
import type { Role } from '../roles.ts';
import { agentEnv, resolveExecutable, type RunInput } from './shared.ts';

export function claudeOptions(
  role: Role,
  ctx: { cwd: string; executable: string; env: Record<string, string> },
): Options {
  return {
    pathToClaudeCodeExecutable: ctx.executable,
    cwd: ctx.cwd,
    env: ctx.env,
    model: role.model,
    effort: role.effort,
    // No user, project or local settings, so no CLAUDE.md, hooks, plugins or
    // MCP servers from disk.
    settingSources: [],
    strictMcpConfig: true,
    // The allowlist is what actually removes subagents (Task), skills (Skill)
    // and the scheduling and messaging tools: an absent tool cannot be called.
    tools: [...role.tools, ...(role.web ? ['WebSearch', 'WebFetch'] : [])],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: role.instructions },
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
  const extra = init.tools.filter((tool) => !allowed.has(tool));
  if (extra.length)
    throw new Error(`Claude loaded tools the role does not allow: ${extra.join(', ')}`);
}

export async function runClaude({ role, prompt, cwd, emit }: RunInput): Promise<boolean> {
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
