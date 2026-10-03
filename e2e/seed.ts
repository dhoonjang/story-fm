import {
  advanceTime,
  allMatchesDone,
  createGame,
  isReserveMatch,
  settleQuickMatch,
  simulateOtherMatches,
  saveGame,
  type GameState,
  type WorldScope,
  eventTexts,
  activeContract,
  addDays,
} from "@story-fm/engine";
import { buildOnboardingTurn } from "@story-fm/agents";

import { DATA_DIR } from "./slot";

/**
 * **브라우저 앞에 미리 놓아 두는 세이브.**
 *
 * 핵심 루프의 뒷부분(시즌 전환)은 앞부분을 다 지나야 닿는다. 그 앞부분을
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
 * (`packages/engine/test/app/season.test.ts`).
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

    ...(opts.world ? { world: opts.world } : {}),
  });
  const intro = buildOnboardingTurn(state);
  state.chat.push({ role: "model", text: intro.text, toolCalls: intro.toolCalls, at: state.date });
  return state;
}

/**
 * 경기일의 우리 경기를 **간이 시뮬로** 치른다 — 이 픽스처가 재려는 것은 지난 경기의 내용이
 * 아니라 시즌을 다 치른 상태다. 서른여덟 경기를 실시간 물리로 굴리면 스펙 하나의 시한을
 * 넘긴다. 정산은 남의 팀 경기와 같은 코어 함수다 (`settleQuickMatch`).
 */
function playMatch(state: GameState): void {
  const today = state.matches.find(
    (m) =>
      m.date === state.date &&
      !m.result &&
      !isReserveMatch(m) &&
      (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
  );
  if (!today) throw new Error("오늘 우리 경기가 없다");
  settleQuickMatch(state, today);
  // 우리 경기보다 늦게 킥오프하는 그날의 나머지 경기 — 마감(`finalizeMatch`)이 하던 몫이다
  simulateOtherMatches(state, { push: () => undefined });
  state.phase = "idle";
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
    if (!advanced.ok)
      throw new Error(`시즌 픽스처가 멎었다: ${eventTexts(advanced.events).join(" / ")}`);
    // 경질은 시계가 멈춘 상태다 — 픽스처가 재려는 것이 아니므로 크게 실패시킨다
    if (advanced.stopped === "blocked") {
      throw new Error(`시즌을 끝내기 전에 막혔다: ${eventTexts(advanced.events).join(" / ")}`);
    }
    if (advanced.stopped === "matchday") playMatch(state);
  }
  if (!allMatchesDone(state)) throw new Error("400번 안에 시즌을 끝내지 못했다");
  saveGame(state);
  return state.id;
}

/** Inquiry and renewal use the same persisted world as the main GM. */
export function seedAgentCenter() {
  const state = appoint({
    teamId: "arsenal",
    managerName: "협상 감독",
    seed: 872,
    world: ONE_LEAGUE,
  });
  const own = state.players.find(
    (player) => player.teamId === state.userTeamId && activeContract(state, player.id),
  );
  const target = state.players.find(
    (player) => player.teamId !== state.userTeamId && activeContract(state, player.id),
  );
  if (!own || !target) throw new Error("협상 여정에 필요한 선수가 없습니다");
  const contract = activeContract(state, own.id)!;
  contract.until = addDays(state.date, 90);
  saveGame(state);
  return {
    gameId: state.id,
    teamId: state.userTeamId,
    ownId: own.id,
    ownName: own.name,
    originalContractId: contract.id,
    targetId: target.id,
    targetName: target.name,
  };
}
