import { ORG } from '../constants.ts';

const issueUrl = new RegExp(
  `^https://github\\.com/${ORG}/([A-Za-z0-9_-][A-Za-z0-9._-]*)/issues/(\\d+)/?(?:[?#].*)?$`,
);

/** The dashboard card a GitHub issue URL points at, or null for any other link. */
export function cardRef(href: string | undefined): { repo: string; number: number } | null {
  const match = href?.match(issueUrl);
  return match ? { repo: match[1]!, number: Number(match[2]) } : null;
}
