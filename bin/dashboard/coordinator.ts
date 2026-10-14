// The coordinator loop behind the dashboard (devkit#31): Claude on the Agent
// SDK with the subscription token, and no tools but the ones below. The agent
// never gets a shell, files or the environment, so it can't reach the App key
// this process holds. Every GitHub write happens here, in code.
import { readFileSync } from 'node:fs';

import { createSdkMcpServer, type Options, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { READY_LABEL, STAGE_LABELS } from '../agent/constants.ts';
import { rest } from '../agent/github.ts';
import { assertClaudeInit } from '../agent/providers/claude.ts';
import { agentEnv, resolveExecutable } from '../agent/providers/shared.ts';
import { refreshGhToken } from './app-token.ts';
import { LEFT_OUT, readThread } from './issue.ts';
import { ORG, REPO_NAME } from './constants.ts';

export const ASK_MODES = ['queue', 'start'] as const;
export type AskMode = (typeof ASK_MODES)[number];

/** The labels a new ask gets: queue waits in Ask for the board loop, start plans now. */
export const ASK_LABELS = {
  queue: [READY_LABEL],
  start: [READY_LABEL, STAGE_LABELS.plan],
} as const satisfies Record<AskMode, readonly string[]>;

// The page follows this tool's call to the issue's thread (chat.ts, page.html).
const OPEN_THREAD_TOOL = 'mcp__github__open_thread';

const INSTRUCTIONS = readFileSync(new URL('../../agents/coordinator.md', import.meta.url), 'utf8');

// Only repos in the org; the agent picks the name, so it is checked, not trusted.
const repo = z.string().regex(REPO_NAME).describe(`repository name in ${ORG}`);

export type CoordinatorEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'route'; repo: string; number: number }
  | { type: 'done'; ok: boolean };

async function github<T>(method: string, path: string, body?: unknown): Promise<T> {
  await refreshGhToken();
  return rest<T>(method, path, body);
}

/** Adds `agent:plan`, which the gate accepts from the App. Also the dashboard's Start button. */
export async function startPlan(name: string, number: number): Promise<void> {
  const args = z
    .object({ repo, number: z.number().int().positive() })
    .parse({ repo: name, number });
  await github('POST', `/repos/${ORG}/${args.repo}/issues/${args.number}/labels`, {
    labels: [STAGE_LABELS.plan],
  });
}

function reply(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

interface Issue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  body?: string | null;
  labels: { name: string }[];
}

const brief = ({ number, title, html_url, state, labels }: Issue) => ({
  number,
  title,
  url: html_url,
  state,
  labels: labels.map((label) => label.name),
});

const githubTools = createSdkMcpServer({
  name: 'github',
  version: '1.0.0',
  tools: [
    tool(
      'search_issues',
      `Search issues in ${ORG} (GitHub search syntax).`,
      { q: z.string() },
      async ({ q }) => {
        const found = await github<{ items: (Issue & { repository_url: string })[] }>(
          'GET',
          `/search/issues?per_page=20&q=${encodeURIComponent(`org:${ORG} is:issue ${q}`)}`,
        );
        return reply(
          found.items.map((issue) => ({
            repo: issue.repository_url.split('/').pop(),
            ...brief(issue),
          })),
        );
      },
    ),
    tool(
      'read_issue',
      'Read an issue and its comments.',
      { repo, number: z.number().int() },
      async (args) => {
        const issue = await readThread(args.repo, args.number);
        return reply({
          number: issue.number,
          title: issue.title,
          url: issue.url,
          state: issue.state,
          status: issue.status,
          labels: issue.labels,
          body: issue.bodyTrusted ? issue.body : LEFT_OUT,
          comments: issue.comments.map((c) => ({
            author: c.author,
            body: c.trusted ? c.body : LEFT_OUT,
          })),
        });
      },
    ),
    tool(
      'file_ask',
      'File a new issue. queue: waits in Ask for the board loop. start: planning starts now.',
      { repo, title: z.string().min(1), body: z.string().min(1), mode: z.enum(ASK_MODES) },
      async (args) => {
        const issue = await github<Issue>('POST', `/repos/${ORG}/${args.repo}/issues`, {
          title: args.title,
          body: args.body,
          labels: ASK_LABELS[args.mode],
        });
        return reply(brief(issue));
      },
    ),
    tool(
      'comment',
      'Comment on an issue. Only for a decision, a result or a question for Troy.',
      { repo, number: z.number().int(), body: z.string().min(1) },
      async (args) => {
        // A stage marker would let the pipeline take this for its own comment.
        if (args.body.trimStart().startsWith('<!-- devkit:'))
          throw new Error('Comments may not carry a pipeline marker.');
        const comment = await github<{ html_url: string }>(
          'POST',
          `/repos/${ORG}/${args.repo}/issues/${args.number}/comments`,
          { body: args.body },
        );
        return reply({ url: comment.html_url });
      },
    ),
    tool(
      'open_thread',
      "Hand a follow-up on an existing issue to that issue's own thread. Troy's message is re-sent there.",
      { repo, number: z.number().int().positive() },
      async () => reply({ routed: true }),
    ),
    tool(
      'start_plan',
      'Start planning an existing issue (adds agent:plan).',
      { repo, number: z.number().int() },
      async (args) => {
        await startPlan(args.repo, args.number);
        return reply({ started: true });
      },
    ),
  ],
});

export function coordinatorOptions(env: NodeJS.ProcessEnv, resume?: string): Options {
  const agent = agentEnv('claude', env);
  return {
    pathToClaudeCodeExecutable: resolveExecutable('claude', agent.PATH),
    env: agent,
    model: 'claude-opus-5-5',
    resume,
    // Nothing from disk, and no built-in tools: only the github server above.
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: { github: githubTools },
    tools: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: INSTRUCTIONS },
  };
}

/** The thread a tool call hands the message to: only a valid `open_thread` call. */
export function routeOf(
  name: string,
  input: unknown,
): Extract<CoordinatorEvent, { type: 'route' }> | null {
  if (name !== OPEN_THREAD_TOOL) return null;
  const { repo, number } = (input ?? {}) as { repo?: unknown; number?: unknown };
  if (typeof repo !== 'string' || !REPO_NAME.test(repo)) return null;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return null;
  return { type: 'route', repo, number };
}

/** One turn of the conversation. `resume` continues an earlier one. */
export async function* coordinate(
  prompt: string,
  resume?: string,
): AsyncGenerator<CoordinatorEvent> {
  const options = coordinatorOptions(process.env, resume);
  for await (const message of query({ prompt, options })) {
    if (message.type === 'system' && message.subtype === 'init') {
      assertClaudeInit(message, options);
      yield { type: 'session', id: message.session_id };
    } else if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') yield { type: 'text', text: block.text };
        else if (block.type === 'tool_use') {
          yield { type: 'tool', name: block.name };
          const route = routeOf(block.name, block.input);
          if (route) yield route;
        }
      }
    } else if (message.type === 'result') {
      yield { type: 'done', ok: message.subtype === 'success' && !message.is_error };
    }
  }
}
