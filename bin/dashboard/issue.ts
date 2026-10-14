import { OPERATOR_ID, PIPELINE_BOT, STATUS_FIELD } from '../agent/constants.ts';
import { graphql, rest } from '../agent/github.ts';
import { refreshGhToken } from './app-token.ts';
import { ORG } from './constants.ts';

// The repos are public, so anyone can comment. Only Troy's and the pipeline's
// words reach the coordinator, as in the pipeline's own snapshot (render.ts).
export const LEFT_OUT = '(Written by someone else, so left out.)';

export function trustedAuthor(user: { id: number } | null | undefined): boolean {
  return user?.id === OPERATOR_ID || user?.id === PIPELINE_BOT.id;
}

export interface IssueComment {
  id: number;
  trusted: boolean;
  author: string;
  body: string;
  at: string;
}

interface RawComment {
  id: number;
  user: { login: string; id: number };
  body: string;
  created_at: string;
}

/** One line for where a thread stands: done, waiting on Troy, or its column and any running stage. */
export function statusLine(issue: {
  state: string;
  status: string | null;
  labels: string[];
}): string {
  if (issue.state === 'closed') return 'Done';
  if (issue.status === 'Needs you') return 'Waiting on you';
  const running = issue.labels.find((label) => label.startsWith('agent:'));
  const column = issue.status ?? 'Not on the board';
  return running ? `${column} · ${running} running` : column;
}

/** The issue as a thread: what it is, its board column, and its comments. */
export async function readThread(repo: string, number: number) {
  await refreshGhToken();
  const path = `/repos/${ORG}/${repo}/issues/${number}`;
  const [issue, comments, board] = await Promise.all([
    rest<{
      user: { id: number };
      title: string;
      html_url: string;
      state: string;
      body: string | null;
      labels: { name: string }[];
    }>('GET', path),
    rest<RawComment[]>('GET', `${path}/comments?per_page=100`),
    graphql<{
      repository: {
        issue: { projectItems: { nodes: { status: { name: string } | null }[] } };
      };
    }>(
      `
        query ($owner: String!, $name: String!, $number: Int!, $field: String!) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              projectItems(first: 5) {
                nodes {
                  status: fieldValueByName(name: $field) {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { owner: ORG, name: repo, number, field: STATUS_FIELD },
    ),
  ]);
  const labels = issue.labels.map((label) => label.name);
  const status =
    board.repository.issue.projectItems.nodes.find((item) => item.status)?.status?.name ?? null;
  return {
    repo,
    number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    body: issue.body ?? '',
    bodyTrusted: trustedAuthor(issue.user),
    labels,
    status,
    line: statusLine({ state: issue.state, status, labels }),
    comments: comments.map((c): IssueComment => ({
      id: c.id,
      trusted: trustedAuthor(c.user),
      author: c.user.login,
      body: c.body,
      at: c.created_at,
    })),
  };
}

export type ThreadView = Awaited<ReturnType<typeof readThread>>;
