# story-fm

> A next-generation football manager game built around an LLM core.
> The player is an **AI manager** who directs the team in natural language, the
> core simulates the match, and every moment is brought to life by AI-generated
> **narrative**.

This file is the single source for the project's **vision and development
conventions**; both AI agents and human contributors work from it. `CLAUDE.md`
points here. **How the game actually behaves lives in
[docs/](docs/README.md)** — start with [overview.md](docs/overview.md).

---

## 1. Vision

Traditional football managers are games of sliders and probability tables.
story-fm turns that into a **game of language**: you direct the team by talking,
players and owners and journalists react as characters with their own motives,
and dressing-room conflict, a prospect's arc and a rivalry continue across matches.

The game serves three experiences:

1. **Life as a manager.** The main GM runs training, everyday scenes and press
   conferences; choices accumulate into stories, memories and relationships.
2. **Negotiation.** The agent center and natural-language conversations connect transfers, renewals and a living market. One GM owns each negotiation.
3. **Live football.** Team building and tactics meet in a spatial match that the
   manager can interrupt and influence through natural language.

### Design principles

1. **Language is the interface.** The UI supports it; it does not replace it.
2. **Explainable outcomes.** Every ruling and every beat must answer "why did
   that happen". Avoid black-box randomness.
3. **Emergent story, exact ledger.** The LLM invents the telling; the core keeps
   state, rules and numbers deterministic.
4. **Quality first, cost second.** Design calls without waste (caching, context
   hygiene), but never let cost cutting degrade the experience.
5. **Give AI room to judge.** Prefer contextual, continuous judgments over extra
   personality tables and scripted story stages. Keep validation, ledgers and match
   physics deterministic. Player abilities, positions, roles, fitness, adaptation
   and form remain readable information for the manager.

## 2. The game in one paragraph

**Language connects story, negotiation and live football.** The user plays the manager and the GM (an LLM)
plays the world. State changes travel exactly one path — skill (tool call) or structured UI action → Zod
validation → deterministic transition — and **match results are decided by the
core's spatial simulator in the live web match and xG simulator elsewhere**; the
LLM only commentates, stages and adjudicates.
A season starts on July 1 and runs preseason → league/cup/European competition →
season rollover → next season. Data has two layers: catalog (immutable seed) and
save (mutable state); `SAVE_VERSION` owns its shape. Lorebooks and conversation digests preserve
narrative; contracts, employment, finances and match records remain validated ledgers.

## 3. Stack

- **Language** — TypeScript, strict, full stack
- **Runtime** — Next.js (App Router) + Node.js
- **Packages** — pnpm monorepo workspaces
- **LLM** — multi-provider, configured **per agent**. `config/llm.yml` is the
  single source for providers and model IDs (→ [docs/common/llm/models.md](docs/common/llm/models.md))
- **Validation** — Zod, enforcing structured LLM I/O
- **Test** — Vitest + Playwright · **Lint** — ESLint + Prettier

### Layout

```
docs/              # present service, grouped by experience
  story/           # everyday life, training, people, press, board and career
  negotiation/     # agent center, negotiations, transfers, renewals and the world market
  match/           # live match, tactics and competitions
  common/          # shared players, teams, contracts, finance, saves, AI infrastructure and UI
config/            # providers, models and game version
apps/
  web/
    app/           # Next routes and API transport
    application/   # whole-game UI and turn orchestration
    domains/       # story/ · negotiation/ · match/ · common/ (ui, lib, styles)
  match-cli/       # headless live match
packages/
  domain/src/      # browser-safe Zod models and pure rules, by domain
  engine/src/      # deterministic commands and read models, by domain
  agents/src/      # model calls, by domain
                   # app/ in each package composes domains; it owns no duplicate rules
  sim/             # match-only deterministic spatial core
  llm/             # shared provider adapters and tracing
packages/*/test/   # same domain ownership; app/ contains integration tests
e2e/               # browser user journeys
```

## 4. Architecture

- **The core rules and keeps the books; the LLM tells the story.** State
  transitions, formulas and validation are deterministic pure functions, tested
  without an LLM. The core decides match results — the manager's match runs as 22
  pieces on the client and is verified by the server checkpoint by checkpoint; the
  manager's instructions reach it only through validated commands and a bounded sheet
  (→ [docs/match/live-match.md](docs/match/live-match.md) ·
  [docs/match/match.md](docs/match/match.md)).
- **The live match is deterministic across engines.** `packages/sim/src/live/` uses
  only arithmetic, `Math.sqrt` and its own `dmath` — never `Math.exp/log/sin/cos/atan2/
hypot/pow`, which differ in the last bit between JavaScript engines and would make the
  client and the server play different matches. `packages/sim` and `packages/domain`
  import nothing from `node:`; the browser runs them as values.
- **Structured output first.** Never make the LLM emit free text for the code to
  parse — force tool calls with Zod schemas, and keep free text for prose humans
  read.
- **Event sourcing.** A match is an event log; narrative, replay and debugging
  all derive from it.
- **Personas are data.** Character and memory live in prompts and state, not in
  code.

## 5. Conventions

### Code

- `strict: true`. No `any` (use `unknown` plus narrowing when unavoidable).
- Functional and immutable by default; isolate side effects at the boundary
  (API/IO).
- Domain types live in `packages/domain`; other packages import from there.
- Runtime dependencies flow `common → {story, negotiation, match} → app`.
  Domains never execute each other or import app values. Cross-domain workflows
  live in `app/workflows`; shared player/team facts and pure queries live in
  common. Type-only references may cross this boundary. ESLint enforces it.
  Internal imports use the owning module, never the package's own public barrel.
- **The screen imports `@story-fm/engine` for types only.** A value import pulls
  `node:fs` into the browser bundle and `next build` dies — `typecheck` passes, so
  **`pnpm lint` is what catches it**: `eslint.config.js` bans the value import
  across `apps/web` — the server-only modules that would drag the engine in with
  them included — and lists the files exempt from it. A pure rule the screen and
  the core both need (`observedFit`, `roleAtSlot`, `ratingTier`) belongs in
  `packages/domain`; the engine re-exports it so core-side callers do not move.
- **One rule, one definition — and a circular import is not a reason to copy.**
  When two modules need the same rule, the rule moves **down** to the package
  both already depend on, and the old sites import it: a pure data rule to
  `packages/domain`, a determinism primitive the match core and the CLI share
  (`makeRng`, `shuffled`) to `packages/sim`, an engine-only rule to the engine
  folder that owns it. `packages/engine` re-exports what it moved down, so
  core-side callers do not move. Two copies of one formula do not diverge
  loudly; they diverge on the day someone tunes one of them.
- **"Skill" names only what the LLM calls directly.** A tool in a GM's catalog is a
  skill; the JSON shape an agent returns is its **output schema**; the deterministic
  function the core invokes from that JSON is a **core command**
  (`packages/engine/src/{story,negotiation,match}/commands/`). Mixing the three makes the docs read as if an
  interpreter agent held tools of its own (→ [docs/overview.md](docs/overview.md) §0).
- kebab-case files and directories, PascalCase types and components, camelCase
  values and functions.
- Give numbers and formulas names — balance tuning should only need to read that
  one function.
- Comments state constraints the code cannot show. History and justification
  belong in docs.

### Commits

- Conventional Commits (`feat:` `fix:` `refactor:` `docs:` `test:` `chore:`).
- One concern per PR — PRs are squash-merged, so one PR is one commit on main and
  the PR title is that commit's subject. **Prompt changes go in their own PR.**
- **A branch's name is not a reason to make another branch.** The worktree already
  arrives on one — work on that, whatever it is called. **There is no branch naming
  convention here**, and a second branch cut to match the names already in the
  history leaves the first one stranded and detaches the work from the branch Orca
  tracks the issue by.
- **When the model's input changes, move the game version** — one line in
  `config/game-version.yml`. Prompts, tool specs, snapshot builders and
  `config/llm.yml` are where it lives; screens, tests and docs never move it.
  Every traced LLM call records the version, so it is what makes a log from
  months ago comparable to today's (→ [docs/common/llm/models.md](docs/common/llm/models.md)
  §5-2; the digit rules and path map are the
  [game-version skill](.agents/skills/game-version/SKILL.md)).
- Commit and push only when the user asks. When a unit of work is done, commit to
  **the branch already checked out** and `git push origin HEAD` — never switch
  branches to commit.
- Name the paths you add. `git add -A` / `.` sweeps up another agent's
  half-finished edits. For the same reason: no rebase, no stash, no branch
  switching.

### Tests

**A test earns its place by catching what nobody would notice.** Deterministic
formulas and curves, invariants, boundary conditions, state transitions — the
things that go wrong quietly and stay wrong. Everything else costs more than it
returns:

| Write a test for                                  | Do not                                            |
| ------------------------------------------------- | ------------------------------------------------- |
| a formula, a curve, a rounding rule               | a string the screen shows the moment it breaks    |
| an invariant (books balance, no duplicate ids)    | what `strict` already rejects                     |
| a boundary (0, cap, last day of the season)       | the implementation restated line by line          |
| a state transition (contract expiry → free agent) | a value the seed owns and a seed change will move |

"It is a new feature" is not a reason on its own. A change whose whole behavior
is visible on screen ships without a test; a change to a number nobody can see
does not.

**Measuring balance is not testing.** A case that plays seasons to see whether
the numbers land in a sensible band has no fixed expectation to regress against,
and it costs minutes. That is a harness, and it lives in `packages/*/harness/` —
outside the suite's `include`, so `pnpm test` never collects the file. Each one
carries a descriptor (`packages/engine/harness/harness.ts`) that owns its band
numbers; assertions, output and the listing all read from it, so a band is written
in exactly one place. `pnpm balance --list` shows every harness and what it
measures, `pnpm balance` runs them
(→ [docs/common/balance-harness.md](docs/common/balance-harness.md)).

**A test timeout breaks what has stopped; it does not measure speed.**
`vitest.config.ts` owns the one number and the reasoning behind it. Never repeat
that number on a case — restating the global is not headroom, and a tighter one
is a hidden speed assertion that goes red before the assertion does. Give a case
its own limit only to make it **more** generous
(→ [balance-harness.md](docs/common/balance-harness.md) §6).

**Fixtures cost more than the logic they carry.** `createTestGame()` builds a
whole world — a second per call. Call the pure function directly when the world
is not what is being tested, and where it genuinely is, build one fixture per
`describe` and share it.

**Suite weight is paid per file, and you do not get it back.** Every test file
imports the engine module graph before it asserts anything, so a file costs CI
whether it holds one case or thirty — the suite is bound by total CPU, not by its
slowest case. Trimming later barely helps: dropping the ten heaviest files, near
half the suite's test time, moved the job by a sixth. So the moment to be sparing
is when a file is **created** — put a new case in the file that already owns that
domain, and open a new one only when none does. The measurements are in
`vitest.config.ts`; that question is settled, do not re-measure it to decide.

- Test the sim core **without an LLM** — fixed seed, deterministic.
- Test LLM-dependent logic with mocks, or at the schema-validation level.
- Never hide a failing test; report it as it is.

**The gate is CI, not your machine.** `.github/workflows/ci.yml` runs
`typecheck` · `lint` · `format:check` · `pnpm test` · `pnpm e2e`, and its verdict
must be green before merging. **It does not run while the PR is a draft** — a branch
still being worked on burns runner minutes nobody reads. Marking the PR ready starts
the run. Every job must be green; a shard is not a sample.

**It also does not run when nothing it could catch has changed.** A change
confined to `.md` files skips the code jobs and lands on the `changes` check
alone. Anything else — one `.ts`, one config line, `ci.yml` itself — runs the
whole gate. Do not widen that rule to try to catch comment-only edits in code: a
path cannot tell a comment from a statement, and the cost of being wrong is a
red change merged green. How the gate is sharded and what it runs on is
`ci.yml`'s business; read it there when you are changing it.

- **While working** — `pnpm typecheck`, `pnpm lint` and `pnpm format`, plus
  `pnpm test <path>` for the file you just wrote. That is the whole local loop.
- **`pnpm typecheck` is three projects, not one** — `tsconfig.json` (packages ·
  match-cli · vitest configs), `apps/web/tsconfig.json` (the Next app, its tests
  and `next.config.ts`) and `tsconfig.e2e.json` (`e2e/` · `playwright.config.ts`).
  They stay apart because the app and the specs need the DOM lib and the
  deterministic core must not see it. A new top-level folder of `.ts` belongs to
  one of the three — a folder no config includes is a folder nothing checks.
- **Do not run the full `pnpm test` or `pnpm e2e` locally.** Both cost minutes
  the CI runner is already paying, and the suite you would run is the one CI
  runs. Run them locally only when the user asks, or when CI has failed and you
  need to reproduce the failure to fix it.
- `pnpm e2e` uses port 3399, `.next-e2e` and `/tmp/story-fm-e2e`. Run **one e2e
  at a time per worktree** — a second concurrent run attaches to the first
  server through `reuseExistingServer` and the two trample each other.
  (`E2E_SLOT=1`–`9` splits port, build output and save directory together if a
  parallel run is genuinely needed.)

### Development agent skills

Shared project skills live in `.agents/skills/`. Claude Code discovers the same
files through symlinks in `.claude/skills/`; edit the shared originals only.
Agents without automatic skill discovery should read the relevant `SKILL.md`:

- [game-version](.agents/skills/game-version/SKILL.md) — decide whether a change
  affects model input and update `config/game-version.yml` accordingly.
- [simulation](.agents/skills/simulation/SKILL.md) — play a fixed scenario for one
  season through the local API, reading and deciding one turn at a time.

### Working alongside others

- Ports 3000 and 3311 belong to the user's dev servers. Never kill them.
- Isolate verification saves with `STORY_FM_DATA_DIR=<tmp>`; never touch
  `apps/web/.data`. The LLM trace store is a separate directory (`apps/web/.log`)
  and it is the user's material for improving the game — read it
  (`pnpm log` — one timeline per turn: calls, commands, checkpoints, ticks), never clear it.
- A pre-existing failure that does not name a file you touched is not yours to
  fix — report it as-is.

### Docs

- When the plan or architecture changes, **update `docs/` before the code**.
- Docs describe **the present only** — no decision logs, no change history. Git
  does that.

## 6. LLM integration rules (most important)

1. **Never hard-code a model ID.** `config/llm.yml` owns provider and model per
   agent; `packages/llm` adapters absorb provider differences
   (→ [docs/common/llm/models.md](docs/common/llm/models.md)).
2. **Validate structured output with Zod** and retry on failure. A parse failure
   never reaches game state.
3. **Context hygiene** — stack input in three layers by change frequency (fixed /
   reference / history) to keep the cache prefix intact. Never interpolate dates
   or IDs into the fixed layer.
4. **Determinism boundary** — the ledger is deterministic, the telling is
   emergent. Emergent output never becomes game state unvalidated. Match and
   training settlement stay within **core anchor ± bound**.
5. **Prompts are code** — separate files or constants so versions and diffs stay
   traceable. ⚠️ **Edit by deleting first.** When the behavior is wrong, delete
   the line that causes it before adding an instruction. Keep the rules; drop
   reasons, analogies and redundant examples — the model reads explanations and
   writes like them.
6. **Cache** identical calls, prompt cache included.
7. **Guardrails** — validate that LLM output cannot break game rules (impossible
   tactics, players who do not exist).

> Never answer Claude API details (model IDs, pricing, caching, tool use) from
> memory — check the current reference (the `claude-api` skill in Claude Code).

## 7. Doc map

**[docs/](docs/README.md) is the single source for what the game does** — each
folder is a layer. Read the design doc for the domain you are touching before you
start, and do not blur the boundary between the deterministic core and the
non-deterministic LLM.

| Folder         | What                                                                                      | Start here                                                          |
| -------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| —              | Whole game and ownership                                                                  | [overview](docs/overview.md) · [architecture](docs/architecture.md) |
| `story/`       | Main GM, people, daily life, training, press and board                                    | [story](docs/story/README.md)                                       |
| `negotiation/` | Negotiation GM, agent center, conditions, medicals, contracts and the world market        | [negotiation](docs/negotiation/README.md)                           |
| `match/`       | Match GM, tactics, live simulation and competitions                                       | [match](docs/match/README.md)                                       |
| `common/`      | Shared state, players, teams, contracts, finance, season orchestration and infrastructure | [common](docs/common/README.md)                                     |

## Status

🚧 **Playable prototype** — save shape is `SAVE_VERSION` (`packages/engine/src/app/persistence.ts`), model input is `config/game-version.yml`. Onboarding → chat
instructions → match → season rollover → multi-season runs end to end. What is
built and what is not is listed in [overview.md](docs/overview.md) §7.

- **No save migrations.** A save of another version is refused; there is no code
  that adapts an old shape. New fields are required in the schema unless absence
  carries meaning. When a change moves the shape or the meaning of stored values,
  bump `SAVE_VERSION` (docs/common/game-state.md §6).
