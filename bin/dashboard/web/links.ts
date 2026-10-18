import type { Status } from '../../agent/constants.ts';
import type { BoardCard } from '../board.ts';
import { ORG, REPO_NAME } from '../constants.ts';

/** A gingur-root GitHub issue or PR URL, or null for any other link. */
export function githubRef(
  href: string | undefined,
): { repo: string; number: number; kind: 'issues' | 'pull' } | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.host !== 'github.com') return null;
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(issues|pull)\/([1-9]\d*)(\/.*)?$/);
  if (!match) return null;
  const [, org, repo, kind, digits, suffix] = match;
  const number = Number(digits);
  if (
    org !== ORG ||
    !REPO_NAME.test(repo!) ||
    !Number.isSafeInteger(number) ||
    (kind === 'issues' && suffix && suffix !== '/')
  )
    return null;
  return { repo: repo!, number, kind: kind === 'issues' ? 'issues' : 'pull' };
}

/** The board card a chat link opens, or null when the link is not a card's. */
export function linkedCard(
  href: string | undefined,
  cards: BoardCard[],
): { repo: string; number: number; column: Status } | null {
  const ref = githubRef(href);
  if (!ref) return null;
  const matches = (item: { repo: string; number: number }) =>
    item.repo === ref.repo && item.number === ref.number;
  const card =
    ref.kind === 'pull'
      ? cards.find((c) => c.pulls.some(matches))
      : (cards.find(matches) ?? cards.flatMap((c) => c.subtasks).find(matches));
  return card ? { repo: card.repo, number: card.number, column: card.column } : null;
}
