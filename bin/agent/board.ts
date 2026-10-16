// The Pipeline board: an org Projects v2 board found by title. Adding an item is
// idempotent (GitHub returns the existing one), so every stage just adds, then
// sets Status, and a plan sets Priority.

import {
  BOARD_TITLE,
  PRIORITY_FIELD,
  STATUS_FIELD,
  type Priority,
  type Status,
} from './constants.ts';
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
  await setOption(repo, contentId, STATUS_FIELD, status, false);
}

/**
 * Adds the issue to its org's board and sets Priority, unless it already has
 * one: a re-plan never overrides a priority the operator or a groom set.
 */
export async function proposePriority(
  repo: string,
  contentId: string,
  priority: Priority,
): Promise<void> {
  await setOption(repo, contentId, PRIORITY_FIELD, priority, true);
}

async function setOption(
  repo: string,
  contentId: string,
  fieldName: string,
  value: string,
  keepExisting: boolean,
): Promise<void> {
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
    { org, field: fieldName },
  );
  const board = organization.projectsV2.nodes.find((node) => node.title === BOARD_TITLE);
  if (!board?.field)
    throw new Error(`No "${BOARD_TITLE}" board with a ${fieldName} field in ${org}.`);
  const option = board.field.options.find((o) => o.name === value);
  if (!option) throw new Error(`The ${BOARD_TITLE} board's ${fieldName} has no "${value}".`);

  const { addProjectV2ItemById } = await graphql<{
    addProjectV2ItemById: { item: { id: string; current: { name: string } | null } };
  }>(
    `
      mutation ($project: ID!, $content: ID!, $field: String!) {
        addProjectV2ItemById(input: { projectId: $project, contentId: $content }) {
          item {
            id
            current: fieldValueByName(name: $field) {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
              }
            }
          }
        }
      }
    `,
    { project: board.id, content: contentId, field: fieldName },
  );
  if (keepExisting && addProjectV2ItemById.item.current?.name) return;
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
