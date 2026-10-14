import { STATUS_FIELD } from '../agent/constants.ts';
import { graphql, rest } from '../agent/github.ts';
import { refreshGhToken } from './app-token.ts';
import { ORG } from './constants.ts';

export interface IssueComment {
  id: number;
  author: string;
  body: string;
  at: string;
}

interface RawComment {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
}

/** The issue as a thread: what it is, its board column, and its comments. */
export async function readThread(repo: string, number: number) {
  await refreshGhToken();
  const path = `/repos/${ORG}/${repo}/issues/${number}`;
  const [issue, comments, board] = await Promise.all([
    rest<{
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
  return {
    repo,
    number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    body: issue.body ?? '',
    labels: issue.labels.map((label) => label.name),
    status:
      board.repository.issue.projectItems.nodes.find((item) => item.status)?.status?.name ?? null,
    comments: comments.map((c): IssueComment => ({
      id: c.id,
      author: c.user.login,
      body: c.body,
      at: c.created_at,
    })),
  };
}

export type ThreadView = Awaited<ReturnType<typeof readThread>>;
