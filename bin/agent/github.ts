// GitHub REST and GraphQL over fetch, authenticated with GH_TOKEN (the App
// installation token minted by `app.token`). Errors carry the API's own body.

import { execFileSync } from 'node:child_process';

import { isStageComment } from './job.ts';

const API = 'https://api.github.com';

let token: string | undefined;

/**
 * Tests, and harnesses run with DEVKIT_APP_ONLY, must never act as the
 * operator (devkit#119): they get the App token or fail.
 */
export function appOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VITEST || env.DEVKIT_APP_ONLY);
}

/** GH_TOKEN, or on the WSL desk, where no App token is minted, the operator's own `gh` login. */
function ghToken(): string {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (appOnly()) {
    throw new Error(
      "GH_TOKEN is not set, and app-only runs never fall back to the operator's gh login.",
    );
  }
  try {
    token ??= execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('GH_TOKEN is not set and `gh` is not logged in.');
  }
  return token;
}

function headers(override?: string): Record<string, string> {
  return {
    authorization: `Bearer ${override ?? ghToken()}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
}

// Generic clients never merge. Only `merge`, called after the deny gate, may merge (devkit#267).
const MERGE =
  /\/pulls\/\d+\/merge\b|\/merges\b|\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch)\b/;

export async function rest<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  if (MERGE.test(path)) throw new Error(`${method} ${path}: the pipeline never merges.`);
  return request(method, path, body, token);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: headers(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/** Every page of a list endpoint. */
export async function restAll<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await rest<T[]>(
      'GET',
      `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
    );
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

export async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  // Only the query: variables carry PR and review text, which may mention a merge.
  if (MERGE.test(query)) throw new Error('GraphQL: the pipeline never merges.');
  return mutate(query, variables);
}

async function mutate<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const { data, errors } = await request<{ data: T; errors?: unknown[] }>('POST', '/graphql', {
    query,
    variables,
  });
  if (errors?.length) throw new Error(`GraphQL: ${JSON.stringify(errors)}`);
  return data;
}

/** The only merge route: callers must pass their merge gate first. */
export async function merge(
  _repo: string,
  pull: { node_id: string; number: number },
  head: string,
  mode: 'auto' | 'now',
): Promise<void> {
  const input = { pullRequestId: pull.node_id, mergeMethod: 'SQUASH', expectedHeadOid: head };
  if (mode === 'now') {
    await mutate(
      'mutation($input:MergePullRequestInput!){mergePullRequest(input:$input){pullRequest{id}}}',
      { input },
    );
    return;
  }
  try {
    await mutate(
      'mutation($input:EnablePullRequestAutoMergeInput!){enablePullRequestAutoMerge(input:$input){pullRequest{id}}}',
      { input },
    );
  } catch (error) {
    if (!(error instanceof Error) || !/clean status/i.test(error.message)) throw error;
    await mutate(
      'mutation($input:MergePullRequestInput!){mergePullRequest(input:$input){pullRequest{id}}}',
      { input },
    );
  }
}

export async function disableAutoMerge(repo: string, pull: { node_id: string }): Promise<void> {
  if (repo !== 'gingur-root/pipeline')
    throw new Error(`${repo}: auto-merge is only allowed on gingur-root/pipeline.`);
  await mutate(
    'mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){pullRequest{id}}}',
    { id: pull.node_id },
  );
}

export interface Comment {
  id: number;
  html_url: string;
  body: string | null;
  user: { type: string; id: number } | null;
}

/** A stage's one comment, found by its marker: edited in place, so a retry doesn't add another. */
export async function upsertStageComment(
  repo: string,
  issue: number,
  role: string,
  body: string,
): Promise<Comment> {
  const path = `/repos/${repo}/issues/${issue}`;
  const existing = await stageComment(repo, issue, role);
  if (existing) return rest('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body });
  return rest('POST', `${path}/comments`, { body });
}

export async function stageComment(
  repo: string,
  issue: number,
  role: string,
): Promise<Comment | undefined> {
  return (await restAll<Comment>(`/repos/${repo}/issues/${issue}/comments`)).find((c) =>
    isStageComment(c, role),
  );
}

/** Removes the trigger label; a `/plan` or `/approve` comment run has none. */
export async function removeLabel(repo: string, issue: number, label: string): Promise<void> {
  await rest('DELETE', `/repos/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`).catch(
    (error: Error) => {
      if (!error.message.includes(' 404 ')) throw error;
    },
  );
}

export async function trustedContents<T>(
  repo: string,
  path: string,
  ref: string,
): Promise<T | null> {
  return rest<T>('GET', `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`).catch(
    (error: Error) => {
      if (!error.message.includes(' 404 ')) throw error;
      return null;
    },
  );
}
