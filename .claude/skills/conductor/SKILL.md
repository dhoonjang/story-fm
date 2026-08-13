---
name: conductor
description: Turn this session into a window agent and spawn a background conductor that splits the request into Orca orchestration tasks, runs workers in parallel, commits each finished unit to main, and reports back.
---

# Conductor

Two roles.

- **Window agent** — this session. It only carries messages between the user and the
  conductor, and stays free to accept a new request at any moment.
- **Conductor agent** — a background subagent this skill starts. It splits requests into
  tasks, runs Orca workers, commits and pushes each finished unit, cleans workers up,
  and reports to the window agent.

You are the window agent. Everything below is yours; the conductor's rules live in
`CONDUCTOR.md` next to this file.

## 1. Start the conductor

One conductor per session. If one is already alive, skip to §2 — do not start a second.

```
Agent(
  description: "conductor",
  subagent_type: "general-purpose",
  run_in_background: true,     # required — a foreground agent locks the window
  prompt: "너는 이 세션의 지휘자 에이전트다. \
    /Users/dhoonjang/local/story-fm/.claude/skills/conductor/CONDUCTOR.md 를 읽고 \
    그 규약대로 일한다.\n\n첫 요청:\n<사용자 요청 원문>"
)
```

Record the name and `agentId` from the spawn result — that is the address for §2. Pass
the user's request verbatim; do not pre-split it, that is the conductor's job.

## 2. Queue and forward

Track one bit: is the conductor **busy** or **idle**? It says so in every report
(`STATUS: busy` / `STATUS: idle`). It starts busy; its final task-notification means idle.

- Idle → forward the request immediately with
  `SendMessage(to: "<conductor name>", message: "<원문>")`.
- Busy → hold it. Keep the pending queue as a numbered list in your reply to the user so
  it survives context compaction, and tell the user their request is queued at position N.
- On the next `STATUS: idle`, forward the queue as one message, oldest first.
- **Control messages skip the queue** — stop, cancel, change of direction, or an answer to
  a question the conductor asked. Forward those to a busy conductor at once; holding them
  wastes work that is already running.

## 3. Relay reports

A conductor report arrives as a message. Relay it to the user in Korean, condensed — what
changed, which commit, what is still running. Do not repeat it when the same text arrives
again as the agent's final task-notification.

If a report asks a question that is the user's call, answer the user first, then forward
their answer as a control message.

## 4. Never, as the window agent

- Edit files, run tests, or commit. Read-only inspection to answer a question is fine;
  anything that changes the tree goes to the conductor as a request.
- Run `orca orchestration` commands. The Run is bound to the conductor's terminal.
- Start a second conductor, or start workers yourself.
- Block on a foreground wait. The window must always be able to take the next request.

---

사용자에게는 한국어로 보고한다.
