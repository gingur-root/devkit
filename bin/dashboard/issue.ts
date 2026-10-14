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

function toComment(c: RawComment): IssueComment {
  return {
    id: c.id,
    trusted: trustedAuthor(c.user),
    author: c.user.login,
    body: c.body,
    at: c.created_at,
  };
}

/** A comment as the model may see it: someone else's words are left out. */
export function forModel(c: IssueComment) {
  return { author: c.author, at: c.at, body: c.trusted ? c.body : LEFT_OUT };
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

/** The issue or pull request as a thread: what it is, its board column, and its comments. */
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
        issueOrPullRequest: {
          projectItems: { nodes: { status: { name: string } | null }[] };
          closingIssuesReferences?: { nodes: { number: number; repository: { name: string } }[] };
        };
      };
    }>(
      `
        query ($owner: String!, $name: String!, $number: Int!, $field: String!) {
          repository(owner: $owner, name: $name) {
            issueOrPullRequest(number: $number) {
              ... on Issue {
                projectItems(first: 5) {
                  ...status
                }
              }
              ... on PullRequest {
                projectItems(first: 5) {
                  ...status
                }
                closingIssuesReferences(first: 10) {
                  nodes {
                    number
                    repository {
                      name
                    }
                  }
                }
              }
            }
          }
        }
        fragment status on ProjectV2ItemConnection {
          nodes {
            status: fieldValueByName(name: $field) {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
              }
            }
          }
        }
      `,
      { owner: ORG, name: repo, number, field: STATUS_FIELD },
    ),
  ]);
  const labels = issue.labels.map((label) => label.name);
  const item = board.repository.issueOrPullRequest;
  const status = item.projectItems.nodes.find((node) => node.status)?.status?.name ?? null;
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
    closes: (item.closingIssuesReferences?.nodes ?? []).map(
      (ref) => `${ref.repository.name}#${ref.number}`,
    ),
    comments: comments.map(toComment),
  };
}

/** A pull request as the model sees it: where it stands, its reviews and checks, and trusted words only. */
export async function readPull(repo: string, number: number) {
  await refreshGhToken();
  const path = `/repos/${ORG}/${repo}/pulls/${number}`;
  const [thread, pull, reviews, reviewComments] = await Promise.all([
    readThread(repo, number),
    rest<{
      draft: boolean;
      merged: boolean;
      merged_at: string | null;
      merged_by: { login: string } | null;
      head: { ref: string; sha: string };
      base: { ref: string };
    }>('GET', path),
    rest<{ user: { login: string } | null; state: string }[]>(
      'GET',
      `${path}/reviews?per_page=100`,
    ),
    rest<RawComment[]>('GET', `${path}/comments?per_page=100`),
  ]);
  const { check_runs } = await rest<{
    check_runs: { status: string; conclusion: string | null }[];
  }>('GET', `/repos/${ORG}/${repo}/commits/${pull.head.sha}/check-runs?per_page=100`);
  const checks: Record<string, number> = {};
  for (const run of check_runs) {
    const result = run.conclusion ?? run.status;
    checks[result] = (checks[result] ?? 0) + 1;
  }
  return {
    number,
    title: thread.title,
    url: thread.url,
    state: thread.state,
    draft: pull.draft,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merged_by: pull.merged_by?.login ?? null,
    head: pull.head.ref,
    base: pull.base.ref,
    closes: thread.closes,
    status: thread.status,
    labels: thread.labels,
    body: thread.bodyTrusted ? thread.body : LEFT_OUT,
    // Reviews arrive oldest first, so each reviewer's last one wins.
    reviews: Object.fromEntries(
      reviews.flatMap((review) => (review.user ? [[review.user.login, review.state]] : [])),
    ),
    checks,
    comments: thread.comments.map(forModel),
    review_comments: reviewComments.map((c) => forModel(toComment(c))),
  };
}

export type ThreadView = Awaited<ReturnType<typeof readThread>>;
