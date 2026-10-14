// The side list: every open issue in the org, newest activity first, each with
// the same status line as its thread's header.
import { STATUS_FIELD } from '../agent/constants.ts';
import { graphql } from '../agent/github.ts';
import { refreshGhToken } from './app-token.ts';
import { ORG } from './constants.ts';
import { statusLine } from './issue.ts';

interface Found {
  search: {
    nodes: {
      number: number;
      title: string;
      url: string;
      state: string;
      repository: { name: string };
      labels: { nodes: { name: string }[] };
      projectItems: { nodes: { status: { name: string } | null }[] };
    }[];
  };
}

export async function threads() {
  await refreshGhToken();
  const { search } = await graphql<Found>(
    `
      query ($q: String!, $field: String!) {
        search(query: $q, type: ISSUE, first: 50) {
          nodes {
            ... on Issue {
              number
              title
              url
              state
              repository {
                name
              }
              labels(first: 20) {
                nodes {
                  name
                }
              }
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
      }
    `,
    { q: `org:${ORG} is:issue is:open sort:updated-desc`, field: STATUS_FIELD },
  );
  return search.nodes.map((issue) => {
    const labels = issue.labels.nodes.map((label) => label.name);
    const status = issue.projectItems.nodes.find((item) => item.status)?.status?.name ?? null;
    return {
      repo: issue.repository.name,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      labels,
      line: statusLine({ state: issue.state.toLowerCase(), status, labels }),
    };
  });
}
