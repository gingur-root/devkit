import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { TOOLS_FILE } from './job.ts';
import type { Env } from './providers/shared.ts';
import { ROLES, type RoleName } from './roles.ts';

export const MANIFEST_PATH = '.devkit/tools.json';

const McpServer = z
  .strictObject({
    url: z.url().optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    secret: z.uuid().optional(),
    env: z
      .string()
      .regex(/^MCP_[A-Z0-9_]+$/)
      .optional(),
    roles: z.array(z.enum(Object.keys(ROLES) as RoleName[])),
  })
  .refine((server) => !!server.url !== !!server.command, 'exactly one of url or command');

export const Tools = z.strictObject({
  mcpServers: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/), McpServer).default({}),
  clis: z.array(z.string().min(1)).default([]),
});
export type Tools = z.infer<typeof Tools>;

export const DEFAULT_TOOLS: Tools = Tools.parse({
  mcpServers: {
    context7: {
      url: 'https://mcp.context7.com/mcp',
      roles: ['plan', 'build', 'repair', 'review', 'elevated'],
    },
  },
});

/** A repo replaces servers by name and adds its CLI requirements to the defaults. */
export function loadTools(inDir: string | undefined): Tools {
  const file = inDir && join(inDir, TOOLS_FILE);
  const repo = Tools.parse(file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
  return {
    mcpServers: { ...DEFAULT_TOOLS.mcpServers, ...repo.mcpServers },
    clis: [...new Set([...DEFAULT_TOOLS.clis, ...repo.clis])],
  };
}

type ClaudeServer =
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> };
type CodexServer =
  | { url: string; bearer_token_env_var?: string }
  | { command: string; args: string[]; env_vars?: string[] };

export interface RoleTools {
  claude: { mcpServers: Record<string, ClaudeServer> };
  codex: Record<string, CodexServer>;
  /** Env var name → Bitwarden UUID. Values never belong in either config. */
  secrets: Record<string, string>;
}

export function renderTools(tools: Tools, role: RoleName): RoleTools {
  const rendered: RoleTools = { claude: { mcpServers: {} }, codex: {}, secrets: {} };
  for (const [name, server] of Object.entries(tools.mcpServers)) {
    if (!server.roles.includes(role)) continue;
    const variable =
      server.env ??
      `MCP_${name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
        .toUpperCase()}_TOKEN`;
    const secret = server.secret;
    if (secret) rendered.secrets[variable] = secret;
    if (server.url) {
      rendered.claude.mcpServers[name] = {
        type: 'http',
        url: server.url,
        ...(secret && { headers: { Authorization: `Bearer \${${variable}}` } }),
      };
      rendered.codex[name] = {
        url: server.url,
        ...(secret && { bearer_token_env_var: variable }),
      };
    } else {
      rendered.claude.mcpServers[name] = {
        type: 'stdio',
        command: server.command!,
        args: server.args,
        ...(secret && { env: { [variable]: `\${${variable}}` } }),
      };
      rendered.codex[name] = {
        command: server.command!,
        args: server.args,
        ...(secret && { env_vars: [variable] }),
      };
    }
  }
  return rendered;
}

/** Select only this role's credentials; never forward the source bag itself. */
export function toolsEnv(rendered: RoleTools, source: Env): Record<string, string> {
  const env: Record<string, string> = {};
  if (!Object.keys(rendered.secrets).length) return env;
  let values: Record<string, unknown>;
  try {
    values = JSON.parse(source.DEVKIT_MCP_SECRETS ?? '{}');
  } catch {
    // JSON.parse can quote a credential in its error text.
    throw new Error('DEVKIT_MCP_SECRETS is not readable JSON.');
  }
  for (const name of Object.keys(rendered.secrets)) {
    const value = values?.[name];
    if (typeof value !== 'string' || !value) throw new Error(`Missing MCP credential ${name}.`);
    env[name] = value;
  }
  return env;
}
