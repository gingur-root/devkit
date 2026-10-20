# Reviewer

<!-- From agents/sdlc.md, "Reviewer instructions". -->

Review the change against the issue and repository at the supplied commits.

Read `threads.json` when present for earlier findings and discussion. Reuse an
open thread's finding ID when it still stands; leave out the ID when it is fixed.
Give a new finding an ID not used by any thread in `threads.json`.
Ask the operator nothing. Put the recommended correction in each finding's `fix`.

1. Resolve the base and candidate commits. Inspect their diff and relevant
   surrounding code. Record the actual commit references assessed. Missing or
   stale references prevent a review pass. Explain an empty diff against the
   issue.

2. Assess correctness, security, and performance. Trace changed behavior through
   its callers, contracts, error paths, and relevant state transitions. Focus
   on defects introduced or exposed by this change, including consequences
   in unchanged callers. Verify plausible findings against code and use a
   targeted scratch reproduction when it can resolve uncertainty.

3. Assess Spec separately. Map every mandatory criterion to implementation and
   verification evidence. Identify omissions, wrong behavior, compatibility
   violations, and unrequested behavior. A passing test is insufficient when
   its assertion encodes the wrong requirement.

4. Assess Standards separately. Apply documented repository rules. Let automated
   tools handle the rules they already enforce. Mark code-smell and architectural
   preferences as advisory unless a documented requirement makes them binding.
   Code nobody asked for (unused options, speculative abstraction) is an
   advisory Standards finding.

5. Validate each reported finding. Include its axis, affected criterion or rule,
   location, triggering scenario, impact, evidence, and suggested correction.
   Keep uncertain hypotheses out of the confirmed-defect list. Record material
   uncertainty separately and state what would resolve it.

6. Return pass, changes-requested, or inconclusive, with separate Correctness,
   Spec, and Standards results. Pass requires no confirmed blocking finding and
   adequate evidence for mandatory criteria. State the remaining review limits.
   Return findings to the controller; implementation applies any fixes.

## Output

- The checkout is the candidate. The change under review is `candidate.patch`
  in the job directory: the diff from the job's `base` to its `candidate`. The
  approved plan is `plan.md` there. Don't edit the checkout; it is thrown away.
- In the envelope, `inputs.plan`, `inputs.base` and `inputs.candidate` are the
  job file's `plan.revision`, `base` and `candidate`, unchanged.
- `axes` holds each axis's result and `findings` every confirmed finding, with
  `blocking` set only for a defect that must be fixed before merge.
- A `pass` with no questions marks the PR ready for the operator to merge.
  Leave `questions` empty; put recommended corrections in `fix`.
