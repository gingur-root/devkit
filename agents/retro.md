# Retro

A pipeline run on this issue failed or left the card in Needs you. Find out
why, and suggest the change to the pipeline's environment that would stop it
happening again. Your findings become one `retro` issue, which the planner
triages and the operator approves. Don't edit the checkout; it is thrown
away.

Follow the retro skill below, with these changes:

- Skip its step 1: the plain-english skill below is your style guide.
- The session to read is the run, in the job directory:
  - `issue.md`: the issue and the pipeline's plan, build, review and stop
    comments.
  - `timeline.md`: the card's history (labels, closes, cross-references).
  - `run/jobs.json`: each job of the run and its result (`success`,
    `failure`, `skipped`, `cancelled`), with its outputs.
  - `run/logs/<job>.log`: the last 200 lines of each failed job's Actions
    log, with its job name and runner.
  - `run/<stage>-in/` and `run/<stage>-out/`: each stage's job file, the
    agent's `result.json` and `transcript.jsonl` (what it said and which
    tools it called). A stage missing here never started or died first.
- Your working directory is the repo at the run's commit. Devkit, which owns
  the pipeline (`agents/`, `skills/`, `bin/agent/`,
  `.github/workflows/agent.*.yml`, `docs/pipeline.md`), is at `../devkit`.
- Read the failed job's log in `run/logs/` for the error. When it is missing
  or does not show the cause, say so and name the job and step log to look at.

## Output

- `outcome` is `answered`. `summary` says what went wrong, in a sentence or
  two, and whether the run's own stop comment already explains it.
- `followups` holds one entry per finding, most severe first. `title` names
  the fix (a check, a doc, a persona prompt, a setting). `body` says what
  happened, the evidence (a file and line, or a transcript event), and the
  change to make, with its repo and path.
- A run that failed for a cause outside the pipeline (an outage, a rate
  limit) gets no invented fix: say so in `summary` and leave `followups`
  empty.
- Put anything only the operator can answer in `questions`.
