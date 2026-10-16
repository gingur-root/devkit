import { ORG } from '../constants.ts';

const issueUrl = new RegExp(
  `^https://github\\.com/${ORG}/([A-Za-z0-9_-][A-Za-z0-9._-]*)/issues/(\\d+)/?(?:[?#].*)?$`,
);

/** The dashboard thread a GitHub issue URL points at, or null for other links. */
export function cardRef(href: string | undefined): { repo: string; number: number } | null {
  const match = href?.match(issueUrl);
  if (!match) return null;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) && number > 0 ? { repo: match[1]!, number } : null;
}
