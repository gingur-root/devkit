// The board (devkit#98, docs/board.md): every card on the org's Pipeline
// board, in its column. A story's column comes from its subtasks.
import { BOARD_TITLE, STATUS_FIELD, STATUSES, type Status } from '../agent/constants.ts';
import { graphql } from '../agent/github.ts';
import { refreshGhToken } from './app-token.ts';
import { ORG } from './constants.ts';

export interface BoardIssue {
  open: boolean;
  /** Null when the issue is not on the board; the loop treats that as Ask. */
  status: Status | null;
}

function ownColumn(issue: BoardIssue): Status {
  return issue.open ? (issue.status ?? 'Ask') : 'Done';
}

/** A card's column: its own, or for a story with subtasks, the one its open subtasks put it in. */
export function cardColumn(issue: BoardIssue & { subtasks: BoardIssue[] }): Status {
  if (!issue.open || !issue.subtasks.length) return ownColumn(issue);
  // A closed subtask is Done, the most advanced column, so it never decides.
  const columns = issue.subtasks.map(ownColumn);
  if (columns.includes('Needs you')) return 'Needs you';
  return columns.reduce((a, b) => (STATUSES.indexOf(a) <= STATUSES.indexOf(b) ? a : b));
}

interface RawIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  updatedAt: string;
  repository: { name: string };
}

interface Items {
  organization: {
    projectV2: {
      items: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          status: { name: string } | null;
          // Empty for a draft issue or a pull request.
          content:
            | (RawIssue & {
                labels: { nodes: { name: string }[] };
                subIssues: { nodes: RawIssue[] };
              })
            | { number?: undefined }
            | null;
        }[];
      };
    };
  };
}

const ISSUE = 'number title url state updatedAt repository { name }';

/** Every issue on the board as a card, most recently updated first. */
export async function board() {
  await refreshGhToken();
  const { organization } = await graphql<{
    organization: { projectsV2: { nodes: { number: number; title: string }[] } };
  }>(
    `
      query ($org: String!, $title: String!) {
        organization(login: $org) {
          projectsV2(first: 10, query: $title) {
            nodes {
              number
              title
            }
          }
        }
      }
    `,
    { org: ORG, title: BOARD_TITLE },
  );
  const project = organization.projectsV2.nodes.find((p) => p.title === BOARD_TITLE);
  if (!project) throw new Error(`No "${BOARD_TITLE}" board in ${ORG}.`);

  const items: Items['organization']['projectV2']['items']['nodes'] = [];
  for (let after: string | null = null; ;) {
    const page: Items = await graphql<Items>(
      `
        query ($org: String!, $number: Int!, $field: String!, $after: String) {
          organization(login: $org) {
            projectV2(number: $number) {
              items(first: 100, after: $after) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  status: fieldValueByName(name: $field) {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                    }
                  }
                  content {
                    ... on Issue {
                      ${ISSUE}
                      labels(first: 20) {
                        nodes {
                          name
                        }
                      }
                      subIssues(first: 50) {
                        nodes {
                          ${ISSUE}
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
      { org: ORG, number: project.number, field: STATUS_FIELD, after },
    );
    const { nodes, pageInfo } = page.organization.projectV2.items;
    items.push(...nodes);
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }

  const issues = items.flatMap((item) =>
    item.content?.number !== undefined
      ? [{ ...item.content, status: (item.status?.name ?? null) as Status | null }]
      : [],
  );
  const key = (i: RawIssue) => `${i.repository.name}#${i.number}`;
  const statusOf = new Map(issues.map((i) => [key(i), i.status]));
  const asBoard = (i: RawIssue & { status: Status | null }) => ({
    open: i.state === 'OPEN',
    status: i.status,
  });

  return issues
    .map((issue) => {
      const subtasks = issue.subIssues.nodes.map((s) => ({
        ...s,
        status: statusOf.get(key(s)) ?? null,
      }));
      return {
        repo: issue.repository.name,
        number: issue.number,
        title: issue.title,
        url: issue.url,
        updatedAt: issue.updatedAt,
        labels: issue.labels.nodes.map((l) => l.name),
        column: cardColumn({ ...asBoard(issue), subtasks: subtasks.map(asBoard) }),
        subtasks: subtasks.map((s) => ({
          repo: s.repository.name,
          number: s.number,
          title: s.title,
          column: cardColumn({ ...asBoard(s), subtasks: [] }),
        })),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export type BoardCard = Awaited<ReturnType<typeof board>>[number];
