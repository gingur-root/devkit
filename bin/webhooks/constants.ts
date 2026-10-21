import { z } from 'zod';

export const DISPATCH_STAGES = ['plan', 'build', 'loop', 'memory', 'research'] as const;
export type DispatchStage = (typeof DISPATCH_STAGES)[number];

export const Dispatch = z.strictObject({
  stage: z.enum(DISPATCH_STAGES),
  repo: z.string().regex(/^[\w.-]+$/),
  issue: z.number().int().positive(),
  actor: z.number().int().positive(),
  comment: z.number().int().positive().optional(),
});
export type Dispatch = z.infer<typeof Dispatch>;

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
