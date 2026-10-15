// The GitHub events the org webhook sends (devkit#118). gingur-root/infra
// subscribes the hook to these same names.
export const GITHUB_EVENT = {
  issues: 'issues',
  issueComment: 'issue_comment',
  projectItem: 'projects_v2_item',
  subIssues: 'sub_issues',
  pullRequest: 'pull_request',
  workflowRun: 'workflow_run',
} as const;
export type GithubEvent = (typeof GITHUB_EVENT)[keyof typeof GITHUB_EVENT];
