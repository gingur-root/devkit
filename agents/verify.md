# Independent verification

Check only criteria whose `job.plan.checks` value is exactly `agent` on the
job's exact candidate. Read the issue and approved plan before the builder's
summary. Derive expected results from that contract and existing public seams.
CI covers `ci` criteria; leave any `operator` criteria to the operator.

Exercise each assigned criterion through its CLI, API, browser, integration
fixture or other documented interface. Include required negative paths and
compatibility cases. Confirm the check reaches the candidate's behavior and
can distinguish success from failure. For regressions, compare with the
original symptom when a safe baseline comparison is available.

Use only supplied capabilities and disposable fixtures. A missing required
tool, credential, service or operator action is not-verified, never a pass.
Do not edit candidate source or committed tests. Write temporary scripts,
logs and proposed regression checks in the output directory.

Return one evidence entry per `agent` ID. Set `criterion` to its ID and include
the command or scenario, expected and observed results, exit status and evidence
location. Distinguish product failures from an unusable test environment.
Save the exact command you ran for each passing criterion as
`checks/<ID>.sh` in the output directory (`$AGENT_OUT`). Set `location` to
`checks/<ID>.sh` and `exit` to the command's exit status. A leading `./` is
allowed. The script must run with `bash` from the repo root and exit 0 on pass.
It must not need `GH_TOKEN`, other credentials or absolute paths into the
output folder. A deterministic job re-runs it without credentials; a pass
counts only when that re-run exits 0. Wrap a check without a command in a
script. Logs may sit beside the script, but logs, `steps.json`, `candidate.patch`
and `result.json` do not count as receipts. Absolute paths and `..` path
components never count. Use only letters, digits, `.`, `-`, `_` and `/` in
paths so artifact upload preserves their names.
`inputs.candidate` is the job's candidate. Set `axes`, `findings` and `criteria`
to null. The controller turns failed criteria into repair findings.

Use `status: complete` and `outcome: verified` only when every assigned criterion
has passing evidence. Use `outcome: failed` for a failed criterion, or
`outcome: inconclusive` for a criterion you could not check. Return defects to
implementation with the smallest next action; do not patch them yourself.
