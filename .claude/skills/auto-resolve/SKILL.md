---
name: auto-resolve
description: >-
  Empty the dhoonjang/story-fm backlog without a human — one tick every 10
  minutes: unstick stalled worktrees, launch the next issue with `resolve`, and
  let each worktree carry itself through `merge`. Ends itself once no open issue
  and no in-flight worktree are left. Use when the user says "이슈 다 처리해줘",
  "백로그 알아서 비워", "자동으로 다 돌려", or invokes /auto-resolve.
---

# Empty the backlog, unattended

This skill is **one tick**. The first invocation arms a 10-minute cron and then
ticks; every later invocation comes from that cron and reads this file again from
§0. When the ending condition stands, it deletes the cron and stops.

⚠️ **Nothing is ever asked.** `resolve` §1-1's "stop and ask the user" and
`merge` §3·§4's "ask the user" are **void under this skill**. Decide, and leave
the reasoning in `docs/` and the PR body. The one exception is §6.

This skill never edits code itself. It picks, launches, unsticks and reports —
the worktree sessions do the work and land it.

## 0. The cron — arm it if it is not armed

`CronList` first. A job whose prompt is `/auto-resolve` already exists → do
nothing here and go to §1. **Two jobs is two ticks racing, and the same issue
gets launched twice.**

None → arm it:

```
CronCreate({ cron: "3-59/10 * * * *", prompt: "/auto-resolve", recurring: true })
```

- `:03 :13 :23 …` — ten minutes apart, off the `:00`/`:30` marks the whole fleet
  lands on (CronCreate's own guidance).
- The job lives **in this session's memory only**. Kill this Claude session and
  the loop dies with it — the worktrees keep working, but nobody advances them.
- It auto-expires after 7 days. §5 normally ends it long before that.
- Keep the returned job id — §5 deletes it by that id.

## 1. Read the board

Three independent calls, one message:

```bash
orca worktree ps --json
gh pr list --state open --limit 50 --json number,title,url,isDraft,headRefName,mergeStateStatus,statusCheckRollup
gh issue list --state open --limit 100 --json number,title,labels,assignees,url
```

- **In flight** = a worktree with `isMainWorktree: false` and a `linkedIssue`.
  Its `agents[].state`, `liveTerminalCount` and `linkedPR` say where it stands.
- **Candidates** = open issues that carry a `priority/` label, have no assignee,
  and are not held by an in-flight worktree. Order them exactly as `resolve` §1
  does: `xhigh` → `high` → `mid` → `low`, oldest number inside the tier. Nothing
  else breaks the tie — not how big the `## 작업` list looks.
- Issues with no `priority/` label are **not** candidates. Name them once in the
  §5 report so they can be triaged.
- An issue assigned to `@me` with **no live worktree and no open PR** is a
  stranded claim from a dead session — `gh issue edit <n> --remove-assignee @me`
  and it becomes a candidate again.

## 2. Ask whether it is over — before anything else

**No candidates and nothing in flight → go to §5.** Do not launch, do not prod,
do not report a tick. The check comes first so a finished loop cannot start one
more piece of work on its way out.

Anything left → §3.

## 3. Unstick what is in flight — the tick's real job

§4's briefing tells each session to carry itself all the way through `merge`, so
a healthy worktree needs nothing from this loop. This step exists for the ones
that stopped.

One row per in-flight worktree. Handles come from
`orca terminal list --worktree issue:<n> --json`.

| What `worktree ps` shows        | What to do                                                                                                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents[].state: "working"`     | Leave it. It is working.                                                                                                                                                                                    |
| `liveTerminalCount: 0`          | **Do not create a second worktree.** Revive in place: `orca terminal create --worktree issue:<n> --command "orca claude-teams" --json`, `orca terminal wait --for tui-idle`, then send §4's briefing again. |
| Idle, no PR yet                 | The briefing never took. Send it again.                                                                                                                                                                     |
| Idle, PR still draft            | Prod (text below).                                                                                                                                                                                          |
| Idle, PR ready and checks green | Prod — it has not run `merge` yet.                                                                                                                                                                          |
| A check is red                  | Prod. Fixing it is that session's job, not this loop's.                                                                                                                                                     |
| A question is on screen         | `orca terminal send --terminal <h> --interrupt`, then send the prod.                                                                                                                                        |

The prod, sent with `--enter`:

```
묻지 말고 계속해라. 밸런스 수치·설계 갈래·파일 충돌은 네가 정하고 왜 그렇게 정했는지 docs 와 PR 본문에 남겨라. 커밋 전 `git merge origin/main` — 리베이스·stash·브랜치 전환 금지. CI 가 초록이면 네가 직접 `.claude/skills/merge/SKILL.md` 를 §1 부터 돌려 머지까지 끝내라. 사람에게 묻는 UI 를 띄우지 마라.
```

**Prodded three ticks running and still not moving** → read
`orca terminal read --terminal <h> --screen`, put what is on that screen into the
report verbatim, and drop that issue from the candidate set for the rest of this
run. One dead worktree does not get to hold the other issues hostage — and
freeing its slot is what lets §4 launch something that will move.

**An open PR whose worktree is gone** strands a branch nobody can land. Revive
it — cut a worktree off the PR's own head, and have the session push back to
that branch:

```bash
orca worktree create --repo name:story-fm --name <slug>-resume \
  --base-branch origin/<headRefName> --issue <n> \
  --agent claude-agent-teams --activate --json
```

Its briefing is §4's plus one line: `이 브랜치는 PR #<pr> 의 head 에서 잘렸다.
끝나면 git push origin HEAD:<headRefName> 로 그 PR 을 갱신하고 거기서 merge 해라.`
Never `git checkout` the PR branch — branch switching is banned (AGENTS.md §5),
and pushing `HEAD:<branch>` is a fast-forward from where this one was cut.

## 4. Fill the free slots — at most four worktrees

**Four in flight is the cap.** A "worktree" here is one issue being worked by one
`resolve` session; the *lanes* `resolve` §4 splits are teammates **inside** one
worktree, and this cap does not count those.

Fill every free slot in this tick, but **launch them one at a time** — pick,
overlap-check, create, confirm, then start over for the next slot. The branch
you just launched is in flight now, so its paths count against the next
candidate's overlap check. Launching them as a batch skips exactly that.

Run `resolve` §1 (pick), §1-1 (overlap), §2 (create + brief), §2-1 (confirm it
took) as written, with three differences:

1. **§1-1's "heavy → stop and ask the user" is void.** Heavy overlap — one open
   PR shares three or more of this issue's paths, or already holds the file its
   tasks mainly target — means **drop to the next candidate without asking**, and
   say in one line what was deferred and why. Light overlap launches as normal,
   with the overlapping paths pasted into the briefing.
2. **Re-read the board between launches.** §1-1's overlap list is stale the
   moment a worktree is created — recompute it against the branch you just
   started before picking the next candidate.
3. **The briefing carries the autonomy clauses**, verbatim:

```
Issue #<n> — <title>.
Read .claude/skills/resolve/SKILL.md and run it from §3 on. You are the lead in this worktree; it is already on its branch — work on that one, whatever it is named.

무인 루프다. 사람에게 아무것도 묻지 마라 — AskUserQuestion 을 쓰지 마라.
- 밸런스 수치·코어 루프·설계 갈래는 네가 정하고, 무엇을 왜 그렇게 정했는지 docs 와 PR 본문에 남겨라.
- 커밋 전 `git merge origin/main`. 리베이스·stash·브랜치 전환 금지 (AGENTS.md §5).
- 레인이 다 들어왔으면 기다리지 말고 네가 직접 `.claude/skills/merge/SKILL.md` 를 §1 부터 돌려 머지까지 끝내라. 그 스킬의 "ask the user" 조항도 무효다 — 충돌은 설계 문서를 읽고 네가 정하고, 이 브랜치가 건드리지 않은 파일에서 난 빨강은 그대로 보고에 싣고 머지해라.
- 푸시하고 몇 초 뒤에 `gh pr ready` 를 올려라. 한 호흡에 하면 CI 가 skipped 로 끝난다. 이미 skipped 면 `gh pr ready --undo && gh pr ready`, 머지 전에 초록 런의 headSha 가 지금 HEAD 와 같은지 확인해라.
- 딱 하나 예외: `SAVE_VERSION` 을 올리거나 `apps/web/.data` 를 지워야 하면 거기서 멈추고 PR 본문에 왜 멈췄는지 적어라.

열린 PR 이 이미 쥐고 있는 파일 — 겹치는 것을 고치기 전에 그 PR 의 diff 를 읽어라:
  <§1-1 이 뽑은 줄 그대로. 겹치는 것이 없으면 이 블록을 통째로 뺀다>
```

Then claim it, exactly as `resolve` §2 does:

```bash
gh issue edit <n> --add-assignee @me
```

## 5. The end — delete the cron and stop

Reached only from §2. Confirm twice before ending, because a false ending
abandons work:

```bash
gh pr list --state open --limit 50 --json number,url    # must be empty
orca worktree ps --json                                  # only the main worktree
```

An open PR still standing means §3's orphan case is waiting — go back to §3 and
let the next tick land it instead of ending here.

Both empty → `CronDelete({ id: <the §0 job id> })`, then report:

- every issue this run closed — number, PR, the commit on main;
- what it never touched: issues with no `priority/` label, and any worktree that
  failed three prods (with what its screen said);
- anything parked under §6;
- that the loop has stopped and nothing is scheduled any more.

## 6. The one place it stops

A change that has to bump `SAVE_VERSION` or wipe `apps/web/.data` — that is the
user's call and always was (AGENTS.md §Status). The worktree session parks there
and writes why in the PR body; **this loop skips that issue and keeps going**,
and raises it in the §5 report as needing a human.

Nothing else parks. Not a balance number, not a conflict, not a design fork.

## The report

One short line per tick — this arrives every ten minutes:

```
틱 4 · 진행 3/4 · 대기 6 · #482 재촉(2회차) · #489 띄움(겹침: docs/simulation/match.md #486)
```

A quiet tick is one line and nothing more. The long report belongs to §5.
