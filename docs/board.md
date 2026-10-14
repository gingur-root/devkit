# Dashboard board: cards as a state machine

Planned (Troy, 2026-10-14). The board itself is built (devkit#98); its
buttons are not yet (devkit#99). The dashboard's main view is a board of
stories and their subtasks. There is no drag: each card shows only
the buttons its column allows. A button is an action, and the pipeline then
moves the card.

![The card state machine](board.excalidraw.svg)

To edit the diagram, open `board.excalidraw.svg` at excalidraw.com, change
it, then _Export image_ → SVG with **Embed scene** on, and overwrite the file.

## Cards

- **Subtask card:** one issue. It follows the table below.
- **Story card:** a parent issue with sub-issues. It shows its subtasks as
  chips with their columns. Its own column comes from its children:
  - **Needs you** if any open subtask is in Needs you.
  - **Done** when every subtask is Done.
  - Otherwise the column of its least-advanced open subtask.
- A story with no subtasks yet is a plain card. Its plan proposes the
  subtasks, and the pipeline files them as sub-issues in Ask (devkit#12).

## Allowed moves

Needs you always goes back to Planning. Planning then decides the next step:
it updates the spec if needed and hands the card to Building, or asks again
and returns it to Needs you. Planning orchestrates; there is no Build button.

| Column    | Buttons                                          | What each button does                                                                                                                                                                                  | Card goes to |
| --------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| Ask       | **Plan**                                         | Adds `agent:plan`.                                                                                                                                                                                     | Planning     |
| Ask       | **Close**                                        | Closes the issue as not planned.                                                                                                                                                                       | Done         |
| Planning  | **Stop**                                         | Cancels the live run.                                                                                                                                                                                  | Needs you    |
| Needs you | **Continue** (optional note, **Elevate** toggle) | Sends the note to the planner as `/plan <note>`. Pressing it is Troy's approval to build. With Elevate on, a confirm step comes first, and the build runs elevated on the WSL desk (`agent:elevated`). | Planning     |
| Needs you | **Close**                                        | Closes as not planned.                                                                                                                                                                                 | Done         |
| Building  | **Stop**                                         | Cancels the live run.                                                                                                                                                                                  | Needs you    |
| Ready     | **Merge**                                        | Merges the PR with Troy's own token, the one used only for merges.                                                                                                                                     | Done         |
| Ready     | **Request changes** (note)                       | Sends the note to the planner, which re-plans and hands back to Building.                                                                                                                              | Planning     |
| Done      | **Reopen**                                       | Reopens the issue.                                                                                                                                                                                     | Ask          |

What Planning does on each entry:

- **From Ask** (a first plan, which the board loop may start on its own):
  always ends in Needs you, so nothing builds without Troy.
- **From Needs you or Ready** (Troy pressed Continue or Request changes):
  if the plan is ready, it moves straight to Building. If not, it asks and
  returns to Needs you.

The pipeline never merges. **Merge** is Troy's own action, done through his
token, the same as clicking Merge on GitHub.

## While a run is live

- A card in Planning or Building shows only **Stop**. No button can queue a
  second run behind a live one. The pipeline would queue it, but a silent
  queue looks like a dead button.
- **Stop** cancels the workflow run. The board loop already handles a
  cancelled run: it posts "stopped at `<stage>`" and moves the card to
  Needs you. Stop adds no new path.
- **Close** is hidden while a run is live. Stop first.
- Editing the issue during a run voids the plan. Planning re-checks it on
  the next Continue, so a stale plan never builds.
- A story's buttons act only on the story issue. Its subtasks keep their own
  buttons, so stopping one subtask never stops its siblings.

## Guarding each button

- The server re-reads the card from GitHub before acting and refuses if the
  column or the live run changed since the page loaded. The page then
  refreshes. This covers two tabs, a phone and a desk, or a run that ended
  between the page load and the tap.
- Buttons that start work write the label or comment. The pipeline sets
  Status as it does today. Only Close and Reopen set Status or the
  issue state directly.
- Only Troy, through Cloudflare Access, sees or presses buttons.

## Open questions

1. **Who acts for a button.** Today only Troy's own actor passes the gate,
   and the App may add only `agent:plan`. Continue (which now carries the
   build approval), Request changes and Stop need the gate to accept the App acting on a button Troy pressed
   behind Access. The other choice is to run those buttons with Troy's merge
   token. That token can do anything Troy can, so it is the wider grant.
