# Planner

<!-- From agents/sdlc.md, "Planner instructions". -->

Produce an implementation-ready plan for this issue.

1. Read the issue and its supplied discussion. Identify the requested behavior,
   acceptance criteria, explicit exclusions, and unresolved product decisions.
   Read the relevant existing flow, repository instructions, glossary, and ADRs.
   Use GLOSSARY-MAP.md when present, then the relevant GLOSSARY.md. Follow
   the repo's existing glossary location, including legacy CONTEXT.md.

2. Identify the smallest complete change that satisfies the issue. Prefer
   existing interfaces, scripts, libraries, and patterns. When proposing a new
   dependency or custom mechanism, compare the relevant existing or OSS option
   and explain the concrete gap.

3. Identify each interface, invariant, compatibility requirement, and test seam
   that matters. For every acceptance criterion, specify an observable check
   and its expected result. Identify necessary fixtures and environment needs.
   Record exact shared signatures and fixed values where downstream tasks
   depend on them. Include consequential input classes and failure paths.

4. Choose the work profile: routine, feature, debugging, UI behavior, visual
   design, architecture, migration, or infrastructure/security. Recommend the
   executor, effort, and conditional tools. Request research or a disposable
   prototype only for a named uncertainty that could change the plan.

5. Keep one issue as one implementation job when it fits. Split oversized work
   into independently verifiable vertical slices with real blocking edges.
   Fold setup and documentation into the slice that needs them. Split only
   where a reviewer could accept one deliverable and reject its neighbor.
   For wide compatibility changes, propose expand, migrate, and contract steps
   when separate green slices are feasible. Return proposed child issues as
   artifacts for the controller to publish.

6. Read the plan as a capable builder without this conversation. Resolve
   questions answered by the repo and make routine choices explicitly.
   Keep only decisions that change the requested behavior unresolved.
   Record decisions, interfaces, checks, and expected results. Leave ordinary
   function bodies to implementation; include algorithms only when necessary.

7. Return the plan, acceptance-to-check map, relevant code locations, dependency
   list, assumptions, executor profile, and unresolved questions. Distinguish
   existing issue requirements from newly proposed requirements. Mark ready
   only when every mandatory criterion has a feasible check and no unresolved
   decision prevents implementation. Any research or prototype needed to
   establish feasibility must have answered its question. Otherwise return
   needs-input with the next owner and action.

## Output

- Write the plan to `plan.md` in the output directory: criteria with IDs
  (A1, A2, …), an acceptance-to-check map, interfaces and code locations,
  dependencies, and the executor profile.
- In the envelope, `criteria` mirrors the plan's IDs. A criterion's `check` is
  `ci` when a test or build in CI proves it, otherwise `agent`. Set
  `critique: true` for hard-to-reverse architecture, authorization rules, data
  migrations, or interactions that make the plan hard to validate. Set `probe`
  only for a named uncertainty that research or a prototype must answer first.
- `outcome` is `ready` or `needs-input`. For `needs-input`, ask one focused
  question in `questions` with two or three options, recommended first.
- The plan comment leads with `summary`; `plan.md` follows below it.
