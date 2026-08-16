---
name: resolve
description: >-
  Start work on a dhoonjang/story-fm issue — the one whose number is passed as an
  argument, or the most urgent oldest open one if none is — in a fresh Orca
  worktree cut off latest main, with a Claude Agent Teams session launched into it
  that writes the docs, opens the draft PR and runs the issue's tasks in parallel
  lanes. Use when the user says "다음 작업 시작해", "이슈 하나 잡고 시작해",
  "할 일 잡아줘", "42번 이슈 시작해", or asks what to work on next and wants it
  started rather than listed.
---

# Resolve the next issue

Two halves. **§1–§2-1 you run here**: pick the issue, launch a worktree with a
Claude Agent Teams session already in it, and watch that session actually take the
briefing. **§3–§7 that session runs**, inside the worktree, and this one stops.

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

A missing `priority/` label is fine here — the user chose it, and the label only
ever existed to let the search choose. Say it is missing and carry on. A missing
`## 작업` list is not fine: §4 reads it. Write one yourself in §3 before splitting
anything.

Then go to §1-1.

**Nothing was named** — search:

```bash
gh issue list --state open --limit 100 --json number,title,labels,assignees,url
```

Choose by this order, no judgment applied:

1. **Priority** — `priority/xhigh`, else `high`, else `mid`, else `low`.
2. **Oldest issue number** within that tier. Nothing else breaks the tie — not
   how big the `## 작업` list looks, not which one reads easier.

Skip an issue if it has an assignee, or if `gh pr list --state open --search
'<number>'` shows a PR already pointing at it — someone is on it. `orca worktree
ps` shows what the other worktrees are already holding; an issue claimed there is
taken too.

An issue missing a `priority/` label is not a candidate. If unlabeled issues
exist, say so at the end so they can be triaged, but do not pick one.

Nothing selectable → say so and stop. Do not invent work.

State the pick and why it won (`priority/high`, oldest of two) before moving on.

## 1-1. Look at what the open PRs already hold

§1 only ever asked whether the **issue** is taken. Ask now whether its **files**
are. One call collects every open PR's changed paths:

```bash
gh pr list --state open --limit 50 --json number,files --jq '
  [.[] | {n: .number, f: .files[].path}]
  | group_by(.f) | map({file: .[0].f, prs: map(.n) | sort})
  | sort_by(-(.prs|length), .file)[]
  | "\(.prs|length)  \(.file)  \(.prs | map("#\(.)") | join(" "))"'
```

Read it twice:

- **The picked issue's paths** — the ones its `## 작업` names — are the ones that
  matter. Every PR on those lines is a branch editing the same file right now.
- **Lines with a count of 2 or more** are already contested. Entering one of them
  makes a third hand on one file.

If the tasks name no paths, say so and match by subsystem instead
(`packages/engine/src/club/**` for a finance issue) — a coarse answer beats none.

**Overlap is not a reason to skip.** Files overlapping is normal; starting
without knowing is the problem. Report what you found, then judge:

- **No overlap** → go to §2.
- **Light** — no single PR shares more than two paths, and none of them is the
  file the tasks mainly target → go to §2, carrying the list.
- **Heavy** — one PR shares **three or more** paths, or any PR already holds the
  file the tasks mainly target → **stop and ask the user.** Name the PR, the
  shared files and the next candidate §1 would have picked, and let them choose
  between the two. Never skip to the next candidate on your own; the backlog
  order is theirs, not yours.

Either way the list goes into the briefing in §2.

## 2. Launch the worktree with a team session in it

Three commands, in this order. **Do not pass `--prompt`** — see below.

```bash
git fetch origin --prune
orca worktree create --repo name:story-fm \
  --name <kebab-slug> \
  --base-branch origin/main \
  --issue <n> \
  --agent claude-agent-teams \
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

Take the handle from the JSON — `result.agentTerminalHandle`, else
`result.startupTerminal.handle` — then **block until the TUI can accept input**:

```bash
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 120000 --json
```

This is the step that makes the handoff fast and certain. Orca's setup hook runs
`pnpm install` in the new worktree, so the agent's prompt is not ready the moment
`create` returns; `tui-idle` returns the instant it is, and not a second later.

Then send the briefing **and submit it** — `--enter` is what presses Return:

```bash
orca terminal send --terminal <handle> --enter --json --text 'Issue #<n> — <title>.
Read .claude/skills/resolve/SKILL.md and run it from §3 on. You are the lead in
this worktree; it is already on its branch — work on that one, whatever it is named.
열린 PR이 이미 쥐고 있는 파일 — 겹치는 것을 고치기 전에 그 PR의 diff를 읽어라:
  packages/engine/src/club/finance.ts  #34 #49
  docs/simulation/finance.md  #34 #35 #45'
```

The briefing is short on purpose — the worktree holds the repo, so point at the
skill rather than restating it.

The overlap lines are §1-1's output, filtered to the paths this issue touches —
paste the lines, not a summary of them, and drop the block entirely when nothing
overlaps. This replaces the eyeballed "주의: #N이 근처를 건드린다": a session that
knows the file and the PR number can read that diff, and one that gets a hint
cannot.

⚠️ **`--prompt` on `worktree create` types the text but does not reliably submit
it here.** Twice it left the briefing sitting unsent at the prompt while the
launching session waited minutes on `terminal read`. `wait` + `send --enter` is
the documented recipe for a launch you need to be sure of (`orca skills get
orca-cli` → Full Handoffs), and it never needs a retry. Never pass both — a
`--prompt` that *does* land plus a `send` is the same briefing twice.

⚠️ **Do not reach for `orca orchestration` here.** Its own guide names this case:
task dispatch, `worker_done` waits and decision gates are for **supervising** a
worker, and `resolve` is a full ownership transfer — this session stops. Creating
a Run and a Task would add coordinator-owned tracking state that nobody reads.

Then claim the issue so a later `resolve` skips it:

```bash
gh issue edit <n> --add-assignee @me
```

**If the launch fails** — no `orca`, or Agent Teams undetected (it needs both the
`orca` CLI and `claude` on PATH, and is unsupported on Windows/WSL) — fall back:
create the worktree without `--agent`, `EnterWorktree({ path })`, and run §3
onward yourself, solo. Say which path you took.

## 2-1. Confirm it took, then stop

`send --enter` returning is not proof the session read it. One read confirms:

```bash
orca terminal read --terminal <handle>
```

It has taken hold when the briefing is echoed at the prompt **and** the session is
doing something with it — a tool call, a plan, its own output. That shows up
within seconds of `tui-idle`, so **one read is enough**. Do not poll `gh pr list`
for the draft PR; that is minutes of waiting for something §3 will report anyway.

If the terminal still sits at an empty prompt, send it again to the **same**
handle — never create a second worktree for the same issue.

Then report: the issue and why it won, the overlap §1-1 found, the worktree path,
the terminal handle, and what you saw the session doing. **Then stop.** Do not enter the worktree and
do not start the work; the session over there owns it now, and two leads on one
branch overwrite each other.

---

*Everything below runs in the new worktree.*

## 3. Docs, then the PR

```bash
pwd                                    # must be the worktree, not /Users/dhoonjang/local/story-fm
git branch --show-current              # the branch §2 created — work on this one
```

`worktree create` already cut the branch and Orca tracks the issue by it. **Its
name is not a reason to cut another** (AGENTS.md §5) — there is no naming
convention to match, and the second branch leaves the tracked one unused.

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
- AGENTS.md conventions apply: deterministic core, no `any`, and **a test only
  where AGENTS.md §5 says one is earned** — a formula, an invariant, a boundary,
  a state transition. A lane whose change is visible on screen the moment it
  breaks writes no test, and says so when it reports;
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
is wrong; re-spawning loses its context. When every lane has landed, run the local
checks yourself — once, from the lead:

```bash
pnpm typecheck && pnpm lint
```

You own the result. A green teammate report is not a green branch.

## 7. Finish

Follow the normal conventions: deterministic core, named paths when you
`git add`, and a test only where AGENTS.md §5 says one is earned — quiet logic
gets one, anything the screen reveals does not.

**The local loop is `pnpm typecheck`, `pnpm lint`, and `pnpm test <path>` for the
files this branch actually wrote.** Nothing else. The full `pnpm test` and
`pnpm e2e` belong to GitHub Actions (`.github/workflows/ci.yml`), which runs them
once `merge` marks this PR ready — running them here just pays for the same
minutes twice (AGENTS.md §5).

So finish like this:

```bash
pnpm typecheck && pnpm lint
pnpm test packages/<pkg>/test/<the-file-you-wrote>.test.ts   # 새로 쓴 것만
git commit -m "<type>(<scope>): <무엇>" -- <named paths>
git push origin HEAD
```

Then **stop.** There is no CI run to watch — the PR is a draft and the workflow
skips drafts. `merge` starts it by marking the PR ready and reads its verdict
there; a red check found there is fixed there.

The PR is squash-merged, so **the PR title and body become the commit message on
main** — keep the title a valid Conventional Commit subject and keep the body
accurate as the work lands. Individual commits on the branch are working notes;
they disappear at merge.

Tick `## 계획` as lanes land. Leave the PR **draft**; `merge` is what marks it
ready, lands it and tears the worktree down.

## Report

From the launching session: the issue and why it won, **which open PRs hold the
same files** (§1-1, with the file names), the worktree path, the terminal handle,
and **what you saw that session doing with the briefing** — the handoff is only
real once it has taken hold (§2-1).

From the worktree session: branch name, draft PR URL, and — if you fanned out —
the lane table with who owns what. Then get on with the work.
