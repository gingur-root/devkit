import { z } from 'zod';

import { OPERATOR_ID, PIPELINE_BOT } from './constants.ts';
import { graphql, rest } from './github.ts';
import type { Job } from './job.ts';

export interface Pull {
  number: number;
  html_url: string;
  node_id: string;
  head: { sha: string };
  base: { sha: string };
}

export function branchOf(job: Job): string {
  return `agent/issue-${job.issue.number}`;
}

export async function openPull(job: Job, branch: string): Promise<Pull | undefined> {
  const owner = job.repo.slice(0, job.repo.indexOf('/'));
  const [open] = await rest<Pull[]>(
    'GET',
    `/repos/${job.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
  );
  return open;
}

export interface Thread {
  id: string;
  node: string;
  resolved: boolean;
  path: string | null;
  line: number | null;
  url: string;
  comments: { author: string; body: string }[];
}

export function findingMarker(id: string): string {
  return `<!-- devkit:finding ${id} -->`;
}

const reviewThreads = z.object({
  repository: z.object({
    pullRequest: z.object({
      reviewThreads: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            isResolved: z.boolean(),
            path: z.string().nullable(),
            line: z.number().nullable(),
            comments: z.object({
              nodes: z.array(
                z.object({
                  body: z.string(),
                  url: z.string(),
                  author: z
                    .object({ login: z.string(), databaseId: z.number().nullable().optional() })
                    .nullable(),
                }),
              ),
            }),
          }),
        ),
      }),
    }),
  }),
});

export async function readThreads(repo: string, pull: number): Promise<Thread[]> {
  const [owner, name] = repo.split('/');
  // shortcut: first 100 threads and comments only; page when a PR passes that.
  const data = reviewThreads.parse(
    await graphql(
      `
        query ($owner: String!, $name: String!, $pull: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $pull) {
              reviewThreads(first: 100) {
                nodes {
                  id
                  isResolved
                  path
                  line
                  comments(first: 100) {
                    nodes {
                      body
                      url
                      author {
                        login
                        ... on User {
                          databaseId
                        }
                        ... on Bot {
                          databaseId
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { owner, name, pull },
    ),
  );
  return data.repository.pullRequest.reviewThreads.nodes.flatMap((thread) => {
    const first = thread.comments.nodes[0];
    const id = first?.body.match(/^<!-- devkit:finding ([^\r\n]+) -->(?:\r?\n|$)/)?.[1];
    if (!id || first?.author?.databaseId !== PIPELINE_BOT.id) return [];
    return [
      {
        id,
        node: thread.id,
        resolved: thread.isResolved,
        path: thread.path,
        line: thread.line,
        url: first.url,
        comments: thread.comments.nodes
          .filter(
            (comment) =>
              comment.author?.databaseId === OPERATOR_ID ||
              comment.author?.databaseId === PIPELINE_BOT.id,
          )
          .map((comment) => ({ author: comment.author!.login, body: comment.body })),
      },
    ];
  });
}

export async function replyThread(node: string, body: string): Promise<void> {
  await graphql(
    'mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}',
    { id: node, body },
  );
}
