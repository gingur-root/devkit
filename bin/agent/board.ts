// The Pipeline board: an org Projects v2 board found by title. Adding an item is
// idempotent (GitHub returns the existing one), so every stage just adds, then
// sets Status.

import { BOARD_TITLE, STATUS_FIELD, type Status } from './constants.ts';
import { graphql } from './github.ts';

interface Board {
  organization: {
    projectsV2: {
      nodes: {
        id: string;
        title: string;
        field: { id: string; options: { id: string; name: string }[] } | null;
      }[];
    };
  };
}

/** Adds the issue to its org's board and sets Status. `repo` is `owner/name`. */
export async function setStatus(repo: string, contentId: string, status: Status): Promise<void> {
  const org = repo.slice(0, repo.indexOf('/'));
  const { organization } = await graphql<Board>(
    `
      query ($org: String!, $field: String!) {
        organization(login: $org) {
          projectsV2(first: 50) {
            nodes {
              id
              title
              field(name: $field) {
                ... on ProjectV2SingleSelectField {
                  id
                  options {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    `,
    { org, field: STATUS_FIELD },
  );
  const board = organization.projectsV2.nodes.find((node) => node.title === BOARD_TITLE);
  if (!board?.field)
    throw new Error(`No "${BOARD_TITLE}" board with a ${STATUS_FIELD} field in ${org}.`);
  const option = board.field.options.find((o) => o.name === status);
  if (!option) throw new Error(`The ${BOARD_TITLE} board has no "${status}" status.`);

  const { addProjectV2ItemById } = await graphql<{
    addProjectV2ItemById: { item: { id: string } };
  }>(
    `
      mutation ($project: ID!, $content: ID!) {
        addProjectV2ItemById(input: { projectId: $project, contentId: $content }) {
          item {
            id
          }
        }
      }
    `,
    { project: board.id, content: contentId },
  );
  await graphql(
    `
      mutation ($project: ID!, $item: ID!, $field: ID!, $option: String!) {
        updateProjectV2ItemFieldValue(
          input: {
            projectId: $project
            itemId: $item
            fieldId: $field
            value: { singleSelectOptionId: $option }
          }
        ) {
          projectV2Item {
            id
          }
        }
      }
    `,
    {
      project: board.id,
      item: addProjectV2ItemById.item.id,
      field: board.field.id,
      option: option.id,
    },
  );
}
