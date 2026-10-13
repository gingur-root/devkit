// GitHub REST and GraphQL over fetch, authenticated with GH_TOKEN (the App
// installation token minted by `app.token`). Errors carry the API's own body.

const API = 'https://api.github.com';

function headers(token: string | undefined): Record<string, string> {
  if (!token) throw new Error('GH_TOKEN is not set.');
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
}

/** `token` defaults to GH_TOKEN; the merge reads checks with the job's own token. */
export async function rest<T>(
  method: string,
  path: string,
  body?: unknown,
  token = process.env.GH_TOKEN,
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
  const { data, errors } = await rest<{ data: T; errors?: unknown[] }>('POST', '/graphql', {
    query,
    variables,
  });
  if (errors?.length) throw new Error(`GraphQL: ${JSON.stringify(errors)}`);
  return data;
}
