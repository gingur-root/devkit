// GitHub REST and GraphQL over fetch, authenticated with GH_TOKEN (the App
// installation token minted by `app.token`). Errors carry the API's own body.

import { execFileSync } from 'node:child_process';

const API = 'https://api.github.com';

let token: string | undefined;

/** GH_TOKEN, or on the WSL desk, where no App token is minted, the operator's own `gh` login. */
function ghToken(): string {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    token ??= execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('GH_TOKEN is not set and `gh` is not logged in.');
  }
  return token;
}

function headers(): Record<string, string> {
  return {
    authorization: `Bearer ${ghToken()}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
}

export async function rest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: headers(),
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
  const { data, errors } = await rest<{ data: T; errors?: unknown[] }>('POST', '/graphql', {
    query,
    variables,
  });
  if (errors?.length) throw new Error(`GraphQL: ${JSON.stringify(errors)}`);
  return data;
}
