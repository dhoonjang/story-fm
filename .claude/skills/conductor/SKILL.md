---
name: conductor
description: Distribute a request to Orca orchestration workers and collect their results, serializing tasks that touch the same code through task dependencies.
---

# Conductor

The invoking session is the conductor. Split the request into tasks, start workers,
collect results. Do not edit files yourself — read-only inspection is fine.

## 1. Bind a Run

Once per session.

```bash
orca orchestration run-list --json
orca orchestration run-use --id <run_id> --json
# none yet:
orca orchestration run-create --objective "<objective>" --json
```

## 2. Create tasks

Search which files the request touches before creating a task. `--deps` enforces only
the order you declare — Orca does not detect that two tasks touch the same file. A
missing dep means two workers edit one file and the later write wins.

```bash
orca orchestration task-list --brief --json          # status dispatched = in flight
orca orchestration task-create --spec "<brief>" --json
orca orchestration task-create --spec "<brief>" --deps '["<blocking_task_id>"]' --json
```

A dependent task stays `pending` and is absent from `--ready` until its dep reaches
`completed`. Start its worker after it turns `ready`.

`files_modified` on a worker's `worker_done` is the record of what it touched. Keep no
separate ledger.

## 3. Start workers

```bash
orca orchestration worker-start --task <task_id> --worktree current --agent claude --json
```

Never create a worktree — a new one isolates `apps/web/.data` and reinstalls deps.
Create every independent task first, start every worker, then wait.

## 4. Wait and settle

```bash
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
```

- A timeout or `{count:0}` is a checkpoint. Keep rolling the wait; coding tasks take
  15–60 minutes. Do not substitute `terminal wait --for tui-idle` polling.
- Answer a `question` with `orca orchestration reply --id <msg_id> --body <answer> --json`.
  Ask the user first when the call is theirs.
- Process every message in a Delivery before `--ack <delivery_id>`.
- On `worker_done`: `orca orchestration worker-release --dispatch <dispatch_id> --json`.
  Never release over a timeout, heartbeat, or idle state.

## 5. Put in every worker brief

Workers share one worktree.

- Port 3000 is the user's dev server. Assign each worker a different port.
- Isolate verification saves with `STORY_FM_DATA_DIR=<tmp>`. Never touch
  `apps/web/.data`.
- No git commits, pushes, stashes, or branch operations.
- Follow AGENTS.md. Korean comments; update `docs/` before code when behavior changes.
- Run `pnpm typecheck`, `pnpm lint`, and the relevant tests. Separate pre-existing
  failures from your own by stashing your changes and rerunning.
- Report with:
  ```bash
  orca orchestration send --type worker_done --subject "<status>" \
    --body "<what changed, findings, what remains>" --task-id <task_id> \
    --dispatch-id <dispatch_id> --outcome succeeded --files-modified "path/a,path/b" --json
  ```
  Use `--outcome failed` for failure; never encode it in prose alone.

## 6. Never

- `worktree create`
- Edit files as the conductor
- Start overlapping tasks without a dep
- `orchestration reset` during active coordination

---

사용자에게는 한국어로 보고한다.
