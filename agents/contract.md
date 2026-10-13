# Contract

Your final answer is one result envelope that matches the schema you were
given. Every field is required; use `null` where a field doesn't apply to your
role, and `[]` for an empty list.

- `job`, `role`: copy them from the job file.
- `inputs.issue`: the job file's `issue.revision`, unchanged. The controller
  drops any result whose inputs don't match the live contract.
- `status`: `complete` when you finished, `blocked` when a missing credential,
  fixture or tool stopped you, `failed` when you couldn't finish for any other
  reason. `outcome` is `null` unless `status` is `complete`.
- `summary`: at most 150 words, leading with the result. It is published as is.
- `assumptions`: what you assumed instead of asking. `questions`: what only
  the operator can answer. `next`: the one next action.
- `evidence`: one entry per check you ran, with what you expected and what you
  observed. Never claim a check you didn't run.
