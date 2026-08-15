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

### Size — decide it yourself

| `size/` | Meaning |
| --- | --- |
| `s` | A sitting — one file or one function, tests included |
| `m` | About a day — one domain, several files |
| `l` | Multiple days, or crosses core/LLM boundaries. **Propose splitting it first.** |

Say which size you chose and why in one clause. If the user disagrees they will
say so.

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

## 완료 조건

- [ ] <무엇이 되면 닫히는가>
```

Do not paste large diffs or file contents — link `path/to/file.ts:42` instead.
If a design doc governs the behavior, link it (`docs/simulation/match.md`).

## Steps

1. Read what the code actually does before describing it. An issue built from an
   assumption sends `resolve` down a wrong road later.
2. Check for duplicates: `gh issue list --search '<keywords>' --state all`.
3. Show the user the draft title, body and your chosen size, and **ask for the
   priority**. Do not create anything until they answer.
4. Create:

```bash
gh issue create --title '<title>' --body '<body>' \
  --label 'priority/<xhigh|high|mid|low>' --label 'size/<s|m|l>'
```

5. Report the issue URL.

## Do not

- Do not file an issue for work the user is asking you to do right now.
- Do not pick the priority yourself, not even for something obviously broken.
- Do not assign, milestone, or add to a project. None of that is in use here.
