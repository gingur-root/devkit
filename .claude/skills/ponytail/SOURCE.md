# Source

The six `ponytail*` skills in `.claude/skills/` are vendored from
[dietrichgebert/ponytail](https://github.com/dietrichgebert/ponytail) at commit
[`2961b52`](https://github.com/dietrichgebert/ponytail/tree/2961b52fc1fe6a5a87c7a959a79512e5c2f3ffe5/skills)
(plugin v5.2.0), MIT licensed (`LICENSE` here). The text is unchanged apart
from oxfmt reformatting (blank lines, table padding, quote style).

Only the skills are copied. They are plain instructions; none runs a script.
The plugin's hooks (session-start auto-activation, mode tracking, statusline)
are left out, so lazy mode is on only when `/ponytail` is invoked or the model
picks the skill. The plugin-install and config notes in `ponytail-help` don't
apply to this copy.

To update, copy `skills/*/SKILL.md` from a newer commit and bump the commit
above, in both gingur-root/devkit and gingur-root/infra.
