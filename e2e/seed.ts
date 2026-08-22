import {
  addDays,
  advanceSegment,
  advanceTime,
  allMatchesDone,
  createGame,
  dealOdds,
  finalizeMatch,
  interpretBackgroundHeuristic,
  saveGame,
  sendOffer,
  startMatch,
  suggestTerms,
  type GameState,
  type WorldScope,
} from "@story-fm/engine";
import { buildOnboardingTurn } from "@story-fm/agents";

import { DATA_DIR } from "./slot";

/**
 * **브라우저 앞에 미리 놓아 두는 세이브.**
 *
 * 핵심 루프의 뒷부분(시즌 전환·이적 성사)은 앞부분을 다 지나야 닿는다. 그 앞부분을
 * 브라우저로 다시 밟으면 시즌 하나에 유저 경기 쉰 번, 턴 왕복 팔백 번이다 — CI가
 * 그것을 낼 수 없다. 그래서 **닿기까지는 코어로 걷고, 재려는 그 한 걸음만 브라우저가
 * 밟는다**: 세이브를 여기서 짓고, 스펙은 그것을 열어 손잡이를 누른다.
 *
 * 짓는 데 쓰는 것은 서버가 쓰는 바로 그 함수들이다(`createGame`·`advanceTime`·
 * `saveGame`). 픽스처 전용 경로가 없으므로 "세이브를 만드는 길이 둘"이 되지 않는다.
 *
 * ⚠️ 세이브는 서버가 읽는 디렉터리에 쓴다 — 슬롯이 그것을 가른다(`e2e/slot.ts`).
 */
process.env.STORY_FM_DATA_DIR = DATA_DIR;

/**
 * 시즌 완주용 세계 — **한 리그 20팀, 컵 없음.**
 *
 * 전체 세계는 한 시즌에 2,100여 경기를 굴려 25초를 쓴다. 리그 하나만 남기면 같은
 * 38라운드를 2.7초에 돈다 — 시즌 전환이 보는 것은 리그 순위표와 일정이므로 컵과 타
 * 리그는 그 판정에 들어가지 않는다. 컵을 지나는 전환은 유닛이 본다
 * (`packages/engine/test/season.test.ts`).
 */
const ONE_LEAGUE: WorldScope = {
  leagues: ["epl"],
  teamsPerLeague: 20,
  cups: false,
  markets: false,
};

/** 부임 — 서버의 `POST /api/games`와 같은 순서로 세계를 짓고 첫 장면을 남긴다 */
function appoint(opts: {
  teamId: string;
  managerName: string;
  seed: number;
  world?: WorldScope;
}): GameState {
  const background = "선수 출신 주장. 은퇴 후 데이터 분석을 공부했다.";
  const state = createGame({
    seed: opts.seed,
    userTeamId: opts.teamId,
    managerName: opts.managerName,
    background,
    attributes: interpretBackgroundHeuristic(background, opts.teamId),
    ...(opts.world ? { world: opts.world } : {}),
  });
  const intro = buildOnboardingTurn(state);
  state.chat.push({ role: "model", text: intro.text, toolCalls: intro.toolCalls, at: state.date });
  return state;
}

/** 경기일 상태에서 구간 시뮬로 한 경기를 끝낸다 — 실모드·mock과 같은 코어 함수다 */
function playMatch(state: GameState): void {
  const started = startMatch(state);
  if (!started.ok) throw new Error(started.message);
  for (let guard = 0; guard < 60 && state.phase === "match"; guard++) {
    const step = advanceSegment(state);
    if (!step.ok) throw new Error(step.message);
    if (step.plan?.stop === "full_time") {
      finalizeMatch(state);
      return;
    }
  }
  throw new Error("경기가 끝나지 않았습니다");
}

/**
 * **시즌의 마지막 경기까지 치른 세이브** — 넘기는 한 걸음만 남겨 둔다.
 *
 * 여기서 `advanceTime`을 한 번 더 부르면 코어가 그 자리에서 시즌을 넘겨 버린다.
 * 그 한 번이 이 픽스처가 브라우저에 넘기는 몫이므로, 남은 경기가 없어지는 순간
 * 멈춘다.
 */
export function seedFinishedSeason(teamId = "arsenal", seed = 406): string {
  const state = appoint({ teamId, managerName: "결산", seed, world: ONE_LEAGUE });
  for (let guard = 0; guard < 400 && !allMatchesDone(state); guard++) {
    const advanced = advanceTime(state, "next_match");
    if (!advanced.ok) throw new Error(`시즌 픽스처가 멎었다: ${advanced.digest.join(" / ")}`);
    // 경질은 시계가 멈춘 상태다 — 픽스처가 재려는 것이 아니므로 크게 실패시킨다
    if (advanced.stopped === "blocked") {
      throw new Error(`시즌을 끝내기 전에 막혔다: ${advanced.digest.join(" / ")}`);
    }
    if (advanced.stopped === "matchday") playMatch(state);
  }
  if (!allMatchesDone(state)) throw new Error("400번 안에 시즌을 끝내지 못했다");
  saveGame(state);
  return state.id;
}

/**
 * **오퍼 한 건이 성사되는 세이브** — 상대와 조건은 여기서 고르고, 넣는 것은 브라우저다.
 *
 * mock GM은 성사 확률로 답을 가른다(`MOCK_ACCEPT_PROB` 50). 아무나 지목하면 그 답이
 * 수락일지 역제안일지가 카탈로그에 달리므로, 스펙은 `if (수락이면)`을 쓰게 된다 —
 * 그 조건문이 이 이슈가 지우려는 것이다. 그래서 **확률이 문턱을 확실히 넘는 상대를
 * 코어에게 물어서** 고르고, 스펙은 그 이름 하나만 받아 조건 없이 단언한다.
 *
 * 문턱은 70이다. 코어의 답신 지연도 이 구간에서 짧아진다(`responseDelayDays`의
 * `probability >= 70` → 0~3일) — 브라우저가 하루씩 미는 횟수를 적게 유지한다.
 */
const TARGET_ODDS_FLOOR = 70;

export function seedTransferTarget(
  teamId = "arsenal",
  seed = 4061,
): {
  gameId: string;
  targetName: string;
} {
  const state = appoint({ teamId, managerName: "영입", seed });
  const tomorrow = addDays(state.date, 1);
  for (const player of state.players) {
    if (player.teamId === teamId) continue;
    const terms = suggestTerms(state, player.id);
    if (!terms) continue;
    if (dealOdds(state, terms).probability < TARGET_ODDS_FLOOR) continue;
    // 동명이인은 mock의 이름 탐색이 다른 선수를 집는다 — 그런 이름은 넘긴다
    if (state.players.filter((p) => p.name === player.name).length > 1) continue;
    /**
     * **답이 내일 오는 상대만 고른다.** 지연은 확률과 해시가 함께 정하므로
     * (`responseDelayDays`) 문턱만으로는 며칠인지 모른다 — 스펙이 손잡이를 몇 번
     * 누를지 세지 않아도 되게, 복제본에 미리 넣어 보고 하루짜리만 통과시킨다.
     */
    const rehearsal = structuredClone(state);
    if (!sendOffer(rehearsal, terms).ok) continue;
    const round = rehearsal.negotiations.at(-1)?.rounds.at(-1);
    if (round?.respondsOn !== tomorrow) continue;
    saveGame(state);
    return { gameId: state.id, targetName: player.name };
  }
  throw new Error(`내일 답이 오는 영입 상대(성사 ${TARGET_ODDS_FLOOR}+)를 찾지 못했다`);
}
