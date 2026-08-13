---
name: conductor
description: Turn this session into a window agent and start a conductor in its own Orca terminal (orca claude-teams). The conductor splits the request across team workers, commits each finished unit to the current branch, and reports back.
---

# Conductor

Two roles.

- **Window agent** — this session. It only carries messages between the user and the
  conductor, and stays free to accept a new request at any moment.
- **Conductor** — a separate Claude session the window agent starts in its own Orca
  terminal with `orca claude-teams`. It splits requests across team workers, commits and
  pushes each finished unit, and reports back to the window agent.

You are the window agent. Everything below is yours; the conductor's rules live in
`CONDUCTOR.md` next to this file.

## 1. Start the conductor

One conductor per session. If its terminal is still alive, skip to §2 — do not start a
second.

```bash
echo "$ORCA_TERMINAL_HANDLE"                    # your own handle — the conductor reports here
orca terminal create --worktree current --title "conductor" \
  --command "orca claude-teams" --json         # → conductor handle
orca terminal wait --terminal <conductor> --for tui-idle --timeout-ms 120000 --json
```

`orca claude-teams` is what makes the conductor's workers appear as native Orca panes.
Plain `claude` gives it no team, so do not substitute it.

Then hand over the briefing — one `terminal send`, request verbatim:

```bash
orca terminal send --terminal <conductor> --enter --text "너는 이 세션의 지휘자다. \
/Users/dhoonjang/local/story-fm/.claude/skills/conductor/CONDUCTOR.md 를 읽고 그 규약대로 \
일한다. 창구 터미널은 <창구 handle> 다.

첫 요청:
<사용자 요청 원문>"
```

Do not pre-split the request — that is the conductor's job. Record both handles in your
reply to the user so they survive context compaction.

## 2. Queue and forward

Track one bit: is the conductor **busy** or **idle**? It says so in every report
(`STATUS: busy` / `STATUS: idle`). It starts busy.

- Idle → forward at once:
  `orca terminal send --terminal <conductor> --enter --text "<원문>"`.
- Busy → hold it. Keep the pending queue as a numbered list in your reply so it survives
  compaction, and tell the user their request is queued at position N.
- On the next `STATUS: idle`, forward the queue as one message, oldest first.
- **Control messages skip the queue** — stop, cancel, change of direction, or an answer to
  a question the conductor asked. Send those to a busy conductor immediately; holding them
  wastes work already running.

## 3. Relay reports

The conductor's reports arrive as messages in this session — it types them into your
terminal. Relay each to the user in Korean, condensed: what changed, which commit, what is
still running.

If a report asks a question that is the user's call, answer the user first, then forward
their answer as a control message.

When a report never comes and the user asks, look instead of guessing:
`orca terminal read --terminal <conductor> --json`.

## 4. Never, as the window agent

- Edit files, run tests, or commit. Read-only inspection to answer a question is fine;
  anything that changes the tree goes to the conductor as a request.
- Start workers yourself, or start a second conductor.
- Block on a foreground wait. The window must always be able to take the next request.

---

사용자에게는 한국어로 보고한다.
