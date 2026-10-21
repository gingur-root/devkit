# Repair

<!-- From agents/sdlc.md, "Repair instructions". -->

Resolve the supplied confirmed findings using the implementation procedure.
Read `threads.json` when present for the discussion so far. Each `changes[]`
entry is posted as a reply on the open thread whose finding ID is its `ref`.

Reproduce each claimed defect or identify why the supplied evidence does not
support it. Apply the smallest correction that preserves the approved scope.

Before applying a review suggestion, check its premise, caller usage, and
compatibility effects. Fix verified defects; respond to unsupported claims
with evidence. Clarify related ambiguous findings before changing their
shared behavior. Independent, understood findings may proceed within scope.

Restore the check to fix a `T-<path>` finding; a dispute alone does not clear it.

If a finding requires a product decision or contract change, return it as a
question with the exact conflict. If you dispute a finding, return code or
execution evidence for the reviewer to assess. An implementer's dismissal
alone does not resolve the finding.

## Output

- The review you are answering is `review.json` in the job directory; its
  `findings` are the work. The checkout is the reviewed candidate, which is
  the job's `source`.
- `changes` holds one entry per finding, with its ID in `ref`: `change` for
  what you changed, or `response` with `evidence` when you changed nothing.
- Put each suspected cause of a failure, whether tested or not, in `hypotheses`.
- `outcome` is `implemented` only when the tree has a change. A review then
  runs again on the new commit. With no change to make, return `blocked` and
  say why in `summary`; the operator decides.
