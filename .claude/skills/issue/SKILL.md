---
name: issue
description: >-
  File a GitHub issue on dhoonjang/story-fm with a priority label and a size
  label. Use when the user says "이슈 올려", "이슈로 만들어줘", "백로그에 넣어",
  "이거 나중에 하자", or describes work to be done later rather than now.
  Also use to capture something noticed mid-task that is out of scope.
---

# File an issue

One issue is one concern. If the request contains two independent pieces of
work, file two issues — `resolve` picks by size, and a bundled issue is
unpickable.

## Labels

Every issue gets exactly one of each. No label means the issue is invisible to
`resolve`.

### Priority — **always ask the user**

Never guess this one. Draft the issue, then ask which tier it belongs to and wait
for the answer. Urgency is the user's call, not something readable from the code.

| `priority/` | Meaning |
| --- | --- |
| `xhigh` | Drop everything |
| `high` | Do this next |
| `mid` | Should be done; nothing is stuck without it |
| `low` | Someday |

### Size — decide it yourself, by counting the tasks

Never guess the size from a feeling about the sentence. **Split the work into
tasks first, write them into the issue, then read the size off the total.**

Splitting the *work* is not splitting the *issue*. One concern stays one issue
even when it is a week long — `resolve` picks one issue and works it end to end.
Never file an `l` as several issues on your own.

**1. Break it into tasks.** A task is one coherent edit that could be one commit:
a file or two plus the test that proves it. Walk the path the change actually
takes through the layers — `docs/` → `packages/domain` (schema) →
`packages/sim`/`engine` → `apps/web` API → UI → tests — and keep only the layers
it really touches. Name the files you found while reading the code.

**2. Weigh each task.**

| Weight | A task that… |
| --- | --- |
| 1 | changes code that already exists, inside one package |
| 2 | adds something new (a schema field, a query, a screen, a view), or spans two packages |
| 3 | crosses the core/LLM boundary, changes a prompt, migrates save data, or needs a balance call from the user |

**3. Sum the weights.**

| `size/` | Total | Reads as |
| --- | --- | --- |
| `s` | ≤ 2 | a sitting |
| `m` | 3–6 | about a day |
| `l` | ≥ 7 | multiple days |

A single-line task list means you did not read the code — go back and read it.
Say the size with its arithmetic in one clause: `size/m — 작업 4개, 가중치 합 5`.
If the user disagrees they will say so.

Add the type label too when it obviously applies: `bug`, `enhancement`,
`documentation`.

## Writing the issue

Title: Conventional-Commit shape without the trailing period, in Korean —
`fix(sim): 퇴장이 승부에 닿지 않는다`. It should read as the problem, not the fix.

Body, in Korean, only the sections that have content:

```markdown
## 무엇이

<현재 동작. 재현 경로나 파일:줄로 짚는다.>

## 왜 문제인가

<게임 경험이나 규약 중 무엇이 깨지는가.>

## 어떻게

<확실할 때만 쓴다. 방향만, 구현 지시가 아니라.>

## 작업

- [ ] <task — 건드리는 파일까지. `packages/sim/src/xg.ts` 처럼.> (1)
- [ ] <task> (2)

## 완료 조건

- [ ] <무엇이 되면 닫히는가>
```

`## 작업`은 사이즈를 계산한 그 목록 그대로다 — 괄호 안은 가중치. 이 절은 항상
쓴다. `resolve`가 이걸 그대로 PR 계획으로 옮긴다.

Do not paste large diffs or file contents — link `path/to/file.ts:42` instead.
If a design doc governs the behavior, link it (`docs/simulation/match.md`).

## Steps

1. Read what the code actually does before describing it. An issue built from an
   assumption sends `resolve` down a wrong road later.
2. Check for duplicates: `gh issue list --search '<keywords>' --state all`.
3. Break the work into tasks and weigh them (→ Size). The reading in step 1 is
   what makes this honest — a task list you could have written without opening
   the repo is a guess.
4. Show the user the draft title, body, the task list and your chosen size with
   its arithmetic, and **ask for the priority**. Do not create anything until
   they answer.
5. Create:

```bash
gh issue create --title '<title>' --body '<body>' \
  --label 'priority/<xhigh|high|mid|low>' --label 'size/<s|m|l>'
```

6. Report the issue URL.

## Do not

- Do not file an issue for work the user is asking you to do right now.
- Do not cut one concern into several issues to make each look small. Big work
  gets a long `## 작업` list and a `size/l`, not three issues.
- Do not pick the priority yourself, not even for something obviously broken.
- Do not assign, milestone, or add to a project. None of that is in use here.
