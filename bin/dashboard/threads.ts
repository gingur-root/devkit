// The side list: every open issue in the org, newest activity first. Each is a
// thread. shortcut: shows labels, not the board column and current step; the
// status line comes with the per-issue view (devkit#74).
import { rest } from '../agent/github.ts';
import { refreshGhToken } from './app-token.ts';
import { ORG } from './constants.ts';

interface Found {
  items: {
    number: number;
    title: string;
    html_url: string;
    repository_url: string;
    labels: { name: string }[];
  }[];
}

export async function threads() {
  await refreshGhToken();
  const { items } = await rest<Found>(
    'GET',
    `/search/issues?per_page=50&sort=updated&q=${encodeURIComponent(`org:${ORG} is:issue is:open`)}`,
  );
  return items.map((issue) => ({
    repo: issue.repository_url.split('/').pop(),
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    labels: issue.labels.map((label) => label.name),
  }));
}
