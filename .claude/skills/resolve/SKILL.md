---
name: resolve
description: >-
  Start work on a dhoonjang/story-fm issue — the one whose number is passed as an
  argument, or the most urgent smallest open one if none is — in a fresh Orca
  worktree cut off latest main, with a Claude Agent Teams session launched into it
  that writes the docs, opens the draft PR and runs the issue's tasks in parallel
  lanes. Use when the user says "다음 작업 시작해", "이슈 하나 잡고 시작해",
  "할 일 잡아줘", "42번 이슈 시작해", or asks what to work on next and wants it
  started rather than listed.
---

# Resolve the next issue

Two halves. **§1–§2 you run here**: pick the issue and launch a worktree with a
Claude Agent Teams session already in it. **§3–§7 that session runs**, inside the
worktree, and this one stops.

The checkout you were called from is never touched — it stays on `main`, and
whatever is uncommitted there belongs to someone else.

## 1. Pick the issue

**An issue was named** — `/resolve 42`, `#42`, a GitHub URL, anything with a
number in it. Take it, skip the search entirely:

```bash
gh issue view <n> --json number,title,body,state,labels,assignees,url
```

Closed, assigned to someone else, or already carrying an open PR (`gh pr list
--state open --search '<n>'`) → say which and stop. The user naming it does not
make it free; two branches on one issue is the thing this check exists to
prevent.

Missing a `priority/` or `size/` label is fine here — the user chose it, and the
labels only ever existed to let the search choose. Say they are missing and carry
on. A missing `## 작업` list is not fine: §4 reads it. Write one yourself in §3
before splitting anything.

Then go to §2.

**Nothing was named** — search:

```bash
gh issue list --state open --limit 100 --json number,title,labels,assignees,url
```

Choose by this order, no judgment applied:

1. **Priority** — `priority/xhigh`, else `high`, else `mid`, else `low`.
2. **Size** within that tier — `size/s`, else `size/m`, else `size/l`.
3. **Oldest issue number** within that cell.

Skip an issue if it has an assignee, or if `gh pr list --state open --search
'<number>'` shows a PR already pointing at it — someone is on it. `orca worktree
ps` shows what the other worktrees are already holding; an issue claimed there is
taken too.

An issue missing a `priority/` or `size/` label is not a candidate. If unlabeled
issues exist, say so at the end so they can be triaged, but do not pick one.

Nothing selectable → say so and stop. Do not invent work.

State the pick and why it won (`priority/high` + `size/s`, oldest of two) before
moving on.

## 2. Launch the worktree with a team session in it

```bash
git fetch origin --prune
orca worktree create --repo name:story-fm \
  --name <kebab-slug> \
  --base-branch origin/main \
  --issue <n> \
  --agent claude-agent-teams \
  --prompt '<briefing, below>' \
  --activate --json
```

- `--base-branch origin/main` starts the branch from main **as the remote has it
  right now**; the fetch above is what makes that true.
- `--issue <n>` links the worktree to the issue in Orca, so `orca worktree ps`
  shows who is on what.
- `--agent claude-agent-teams` is the whole point: Orca launches
  `orca claude-teams` in the worktree's first terminal, so the session that picks
  up the work has Agent Teams on from its first turn and its teammates open as
  native Orca panes. Plain `--agent claude` cannot fan out later — the mode is
  fixed at launch.
- `--prompt` is injected into that session after it starts.

The briefing is short — the worktree holds the repo, so point at the skill rather
than restating it:

```
Issue #<n> — <title>.
Read .claude/skills/resolve/SKILL.md and run it from §3 on. You are the lead in
this worktree; the branch is not created yet.
```

Then claim the issue so a later `resolve` skips it, and report the handoff:

```bash
gh issue edit <n> --add-assignee @me
```

Report the issue, the worktree path and the terminal handle from the JSON
(`result.agentTerminalHandle`, else `result.startupTerminal.handle`) — `orca
terminal read --terminal <handle>` is how anyone checks on it. **Then stop.** Do
not enter the worktree and do not start the work; the session over there owns it
now, and two leads on one branch overwrite each other.

**If the launch fails** — no `orca`, or Agent Teams undetected (it needs both the
`orca` CLI and `claude` on PATH, and is unsupported on Windows/WSL) — fall back:
create the worktree without `--agent`, `EnterWorktree({ path })`, and run §3
onward yourself, solo. Say which path you took.

---

*Everything below runs in the new worktree.*

## 3. Branch, then docs, then the PR

```bash
pwd                                    # must be the worktree, not /Users/dhoonjang/local/story-fm
git switch -c <type>/<kebab-slug>
```

`<type>` is the Conventional-Commit type from the issue title (`feat` `fix`
`refactor` `docs` `test` `chore`) — `fix/red-card-reaches-result`. This matches
the branches already in the history.

Read the issue body and the design docs it points at (`docs/` is the single
source — AGENTS.md §7). If the task changes behavior, **update `docs/` to
describe the new behavior and commit that** — the convention is docs before code,
and it also gives the branch the commit GitHub needs to open a PR.

```bash
git commit -m "docs(<scope>): <무엇이 달라지는가>" -- docs/<changed>.md
git push -u origin HEAD
gh pr create --draft --base main \
  --title '<issue title>' \
  --body "$(cat <<'EOF'
Closes #<n>

## 무엇을

<이슈가 요구하는 것 한두 줄.>

## 계획

- [ ] <단계>
EOF
)"
```

The issue's `## 작업` checklist is the plan — copy it into `## 계획` rather than
inventing a second one, dropping the weights. If the issue has none, write one
before you start.

`Closes #<n>` is what closes the issue on merge — do not omit it.

If the task genuinely touches no docs (a pure refactor, a chore), make the first
real code commit instead and open the PR after it. Never anchor the branch with
an empty placeholder commit.

Orca's setup hook already ran `pnpm install` and a dev server for this worktree.
Do not start another, and do not kill ports 3000 or 3311 — those are the user's
(AGENTS.md §5).

## 4. Split the tasks into lanes, or don't

The issue's `## 작업` list decides this.

**Two tasks or fewer → work it yourself.** Skip to §7. A team costs a briefing
per teammate and a review of what comes back; below three tasks that is pure loss.

**Three or more → look for lanes.** A lane is a set of tasks that owns a set of
paths **no other lane touches**. Write the partition down before spawning
anything:

| Lane | Tasks | Paths it owns |
| --- | --- | --- |
| `sim` | 2, 3 | `packages/sim/src/xg.ts`, its test |
| `web` | 4, 5 | `apps/web/app/match/**` |

Rules that make the partition real:

- **A path belongs to exactly one lane.** Two lanes editing one file in one
  worktree is a lost edit, not a conflict — there is no merge to resolve.
- **Shared foundations are not a lane.** `docs/`, `packages/domain` schemas, a
  new type everything else imports — the lead does those **first**, commits them,
  and only then fans out. Everyone builds on a foundation that already exists.
- **Sequential tasks stay together.** If task 5 only makes sense after task 4,
  they are one lane.
- **At most three lanes.** Beyond that the briefing and review cost more than the
  parallelism returns.

If the tasks refuse to partition — everything lands in the same two files — say so
and work solo. That is a normal outcome, not a failure.

## 5. Run the lanes in parallel

This session was started by `orca claude-teams`, so teammates are available and
come up as Orca panes the user can watch. Spawn every lane **in one message**,
one `Agent` call each with `name` set to the lane name. (No `name` parameter on
the Agent tool means Agent Teams did not come up — say so once and work solo.)

Each briefing carries, and carries nothing else:

- the issue number and its `## 무엇이` / `## 왜 문제인가`, quoted — not a link;
- the lane's tasks, verbatim from `## 작업`;
- **the exact paths the lane owns, and the sentence "do not edit any path outside
  this list — another agent owns it"**;
- the design doc that governs the behavior (`docs/…`);
- AGENTS.md conventions apply: deterministic core, no `any`, tests alongside;
- **do not commit, do not push, do not run `git add`** — the lead commits;
- verify with the narrowest thing that proves the lane (`pnpm test <path>`), not
  the full suite. `pnpm typecheck` and `pnpm lint` write shared build state; three
  at once trample each other. The lead runs those, once, at the end;
- report back: what changed in which files, what the test proves, what is left.

## 6. Land the lanes

As each lane reports, **review the diff and commit that lane by named path** —
one commit per lane, serialized, so nothing races `.git/index.lock`:

```bash
git diff -- <lane paths>
git commit -m "<type>(<scope>): <lane>" -- <lane paths>
```

A lane that comes back wrong is `SendMessage`d back to the same teammate with what
is wrong; re-spawning loses its context. When every lane has landed, run the real
gate yourself:

```bash
pnpm typecheck && pnpm test && pnpm lint
```

You own the result. A green teammate report is not a green branch.

## 7. Finish

Follow the normal conventions: deterministic core, tests alongside, named paths
when you `git add`. `pnpm test` / `typecheck` / `lint` are the loop's gate — e2e
belongs to `merge` (AGENTS.md §5).

The PR is squash-merged, so **the PR title and body become the commit message on
main** — keep the title a valid Conventional Commit subject and keep the body
accurate as the work lands. Individual commits on the branch are working notes;
they disappear at merge.

Tick `## 계획` as lanes land. Leave the PR **draft**; `merge` is what marks it
ready, lands it and tears the worktree down.

## Report

From the launching session: the issue and why it won, the worktree path, the
terminal handle, and that the work has been handed to the session running there.

From the worktree session: branch name, draft PR URL, and — if you fanned out —
the lane table with who owns what. Then get on with the work.
