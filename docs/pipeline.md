# Using the agent pipeline

How to take an issue from idea to merged PR with the agents. Only Troy can
start a stage: every job checks the actor, so labels or comments from anyone
else do nothing.

A repo is enrolled when it has a thin `agents.yml` caller (see
[scratch's](https://github.com/gingur-root/scratch/blob/main/.github/workflows/agents.yml))
and the `RUNNER` and `PIPELINE_APP_ID` vars.

## The flow

| Step               | You do                                                                                                   | The pipeline does                                                                  | Board card       |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------- |
| 1. File            | Open an issue: what you want and how you'd know it's done. Add `ready-for-agent` to put it on the board. | The board adds the card.                                                           | Ask              |
| 2. Plan            | Add `agent:plan`, or comment `/plan`.                                                                    | Writes one plan comment, removes the label.                                        | Planning         |
| 3. Answer          | Read the plan. If it asks questions, edit the issue to answer them, then `agent:plan` again.             | Rewrites the same plan comment.                                                    | Needs you        |
| 4. Approve / build | When the plan says **ready for `agent:build`**, add `agent:build`. That label is the approval.           | Builds on `agent/issue-<n>`, opens a draft PR, comments a link, removes the label. | Building → Ready |
| 5. Review / merge  | Review and merge the PR, or have a project thread merge it.                                              | Board moves the card when the PR merges or the issue closes.                       | Done             |

Anything that stops a run (a failed check, a missing result, a push error)
posts **"… stopped at `<stage>`"** on the stage's comment and moves the card
to **Needs you**. Fix the cause, then add the label again.

## Review and merge stage

_Pending [devkit#32](https://github.com/gingur-root/devkit/pull/32)._ Once it
lands, `agent:build` also reviews its own PR in the same run, so your plan
approval stays the only label you add. A clean review leaves the card in
**Ready**; anything else stops in **Needs you**.

The pipeline never merges. Merging is yours, or a Claude project thread's under
the project's merge policy.

## Known limits

- **Re-run doesn't work.** Jobs only run on a run's first attempt, so the
  Actions "Re-run" button skips everything. Add the label again instead.
- **Editing the issue or the plan comment voids the plan.** `agent:build`
  refuses until you run `agent:plan` again.
- **A workflow-file change on main blocks a build retry.** If main changed
  anything under `.github/workflows/` since the branch was made, the push to
  `agent/issue-<n>` is rejected (the App has no `workflows` permission). Close
  the PR and delete the branch, then add `agent:build` again.
- **No `/revise` yet.** It passes the gate but no stage handles it; edit the
  issue and re-plan instead.
- **One run per card at a time.** A second label while one runs waits in the
  queue.
