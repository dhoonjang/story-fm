/**
 * **스카우팅 — 정보 비대칭을 푸는 명령** (player.md §8).
 *
 * 이름을 지목한 파견과 조건으로 내보내는 임무. 둘 다 며칠 뒤 tick이 보고서를
 * 세우고, 그때부터 그 선수의 안개가 걷힌다.
 */
import type { MarketCard, ScoutMission } from "@story-fm/domain";
import {
  POSITION_CODES,
  MISSION_CANDIDATES,
  MISSION_DAYS,
  SCOUT_CONCURRENT_LIMIT,
  SCOUT_DAYS,
} from "@story-fm/domain";
import { addDays } from "../competition/calendar";

import {
  SCOUT_REPEAT_LIMIT,
  activeMissions,
  completedScoutReports,
  deferScout,
  dropDeferredScout,
  earliestScoutReturn,
  freeScoutSlots,
  inFlightScoutLabels,
  missionBrief,
  missionLabel,
  missionScope,
  sameMissionConditions,
  waitingMissions,
} from "../squad/scouting";
import { resolveCompetition } from "../world/player-pool";
// 면담에서 한 약속은 장부에 선다 (people.md §5-2 · career.md §2)
// 감독이 지목한 번호는 코어가 배정하고, 사실만 돌려준다 (player.md §1.1)
// 면담의 사기는 감독과 그 선수 사이의 등급을 탄다 (people.md §6 「관계 등급」)
// 잔향 — 그 대화를 쥔 호출이 심경 한 문장을 남긴다 (people.md §5)
// 판정은 수용성 앵커 ± 한 단계 안에서만 선다 (career.md §2)
import { teamName, type GameState } from "../core/state";
import { pickAnyPlayer } from "../core/player-ref";
import type { MarketCommandResult } from "./result";

// ---- 스카우팅 (정보 비대칭 해제) ----

/**
 * 스카우트 파견 — 타 팀 선수 한 명을 지목해 보고서를 요청한다.
 * SCOUT_DAYS 뒤 tick이 완료 처리하고, 그때부터 능력치 안개가 걷힌다.
 *
 * **거듭 보낼 수 있다.** 첫 리포트가 능력치를 열어 준다면, 두 번째·세 번째는
 * 잠재력 추정을 좁힌다 — 한 번 보고 성장 여력을 단정하는 스카우트는 없다
 * (SCOUT_REPEAT_LIMIT까지 · scouting.ts 규약).
 */
export function scoutPlayer(state: GameState, ref: string): MarketCommandResult {
  const pick = pickAnyPlayer(state, ref);
  if (!pick.ok) return pick;
  const player = pick.player;
  const playerId = player.id;
  if (player.teamId === state.userTeamId) {
    return { ok: false, message: `${player.name}은(는) 우리 선수입니다 — 이미 다 알고 있습니다` };
  }
  const pending = state.scoutReports.find(
    (r) => r.gamePlayerId === playerId && r.completedOn === null,
  );
  if (pending) {
    return {
      ok: false,
      message: `${player.name}에게는 이미 스카우트를 보냈습니다 — 보고 예정 ${pending.dueOn}`,
    };
  }
  const done = completedScoutReports(state, playerId);
  if (done >= SCOUT_REPEAT_LIMIT) {
    return {
      ok: false,
      message: `${player.name}은(는) ${done}번 살펴봤습니다 — 더 보내도 새로 알 게 없습니다`,
    };
  }
  /**
   * 자리는 **임무와 함께 센다** — 조건으로 나간 스카우트도 같은 스카우트진이다
   * (player.md §9.4).
   */
  if (freeScoutSlots(state) <= 0) {
    /**
     * **무엇이 나갔고 무엇이 안 나갔는지 이름으로 말한다.** 한도만 알려 주면
     * 감독은 지목한 넷 중 누가 빠졌는지 알 수 없다.
     *
     * 그리고 못 나갔다는 사실을 대기로 남긴다 — 이 문구는 이 턴에만 살아 있어,
     * 남기지 않으면 다음 턴의 모델에는 넷째를 읽을 자리가 없다
     * (→ [docs/data/player.md](../../../../docs/data/player.md) §9.4).
     */
    deferScout(state, playerId);
    return {
      ok: false,
      message:
        `${player.name}(${teamName(player.teamId)})은(는) 보내지 못했습니다 — 동시 파견 한도 ` +
        `${SCOUT_CONCURRENT_LIMIT}이 차 있습니다 (파견 중: ${inFlightScoutLabels(state).join(", ")}). ` +
        `${earliestScoutReturn(state)} 보고가 들어오면 자리가 납니다. ` +
        `${player.name} 요청은 대기로 남습니다 — 자리가 난 뒤 다시 불러야 나갑니다`,
    };
  }
  const dueOn = addDays(state.date, SCOUT_DAYS);
  state.scoutReports.push({
    // 재파견이 있으므로 날짜만으로는 id가 겹칠 수 있다
    id: `scout-${playerId}-${state.date}-${state.scoutReports.length}`,
    gamePlayerId: playerId,
    requestedOn: state.date,
    dueOn,
    completedOn: null,
  });
  // 대기하던 요청이 드디어 나갔다 — 남겨 두면 나간 파견이 "안 나갔다"로 읽힌다
  dropDeferredScout(state, playerId);
  /**
   * 파견은 아직 아무 장부도 바꾸지 않았다 — 갈 화면이 없으므로 **카드**로 선다.
   * 며칠 뒤 도착하는 보고서 카드와 같은 흐름에 놓여 "보냈다 → 왔다"가 이어진다.
   */
  const card: MarketCard = {
    kind: "scout",
    playerId,
    playerName: player.name,
    counterpart: teamName(player.teamId),
    // 우리 선수는 위에서 걸러졌다 — 파견이 나갔다면 데려올 선수를 본 것이다
    direction: "in",
    dueOn,
    ...(done > 0 ? { note: `${done + 1}번째 파견` } : {}),
  };
  return {
    ok: true,
    payload: card,
    message:
      `${player.name}(${teamName(player.teamId)}) 스카우트 파견 — 보고 예정 ${dueOn}` +
      (done > 0 ? ` (${done + 1}번째 파견)` : ""),
  };
}

/**
 * 감독이 조건으로 부르는 파견 — 이름이 없다 (→ docs/data/player.md §9.4).
 * 대회는 감독이 부르는 이름 그대로 받는다("프리미어", "챔스", "라리가").
 */
export interface ScoutMissionInput {
  competition?: string;
  position?: string;
  minAge?: number;
  maxAge?: number;
  /** 관측 시장가 상한 (£) — 참값이 아니라 흐린 값으로 거른다 (player.md §10) */
  maxValue?: number;
}

/**
 * **스카우트 임무 파견** — 조건 한 벌을 주고 후보 `MISSION_CANDIDATES`명을 받는다.
 *
 * 지목(`scoutPlayer`)과 **같은 자리를 나눠 쓴다** — 자리를 세는 자는 `freeScoutSlots`
 * 하나뿐이라, 임무 셋이 나가 있는 날에는 지목도 나가지 못한다.
 *
 * 후보를 여기서 고르지 않는다 — 조건만 적고 `MISSION_DAYS` 뒤 tick이 그날의 상태로
 * 줄을 세운다. 지금 고르면 두 주 동안 값도 나이도 움직인 뒤에 도착한 목록이 두 주
 * 전의 세계를 말한다.
 */
export function scoutMission(state: GameState, input: ScoutMissionInput): MarketCommandResult {
  const competition = resolveCompetition(input.competition);
  if (!competition.ok) return competition;

  const position = input.position?.trim().toUpperCase();
  if (position !== undefined && !POSITION_CODES.includes(position)) {
    return {
      ok: false,
      message: `"${input.position}"라는 자리는 없습니다 — ${POSITION_CODES.join("·")}`,
    };
  }
  /**
   * 뒤집힌 나이 조건은 **아무도 지나지 못한다.** 그대로 받으면 두 주 뒤에야 "후보
   * 없음"이 답으로 오고, 감독은 그 리그에 스물셋 이하가 없다고 읽는다.
   */
  if (input.minAge !== undefined && input.maxAge !== undefined && input.minAge > input.maxAge) {
    return {
      ok: false,
      message: `나이 조건이 뒤집혔습니다 — ${input.minAge}세 이상 ${input.maxAge}세 이하를 함께 지나는 선수는 없습니다`,
    };
  }

  const draft: ScoutMission = {
    id: `mission-${state.date}-${(state.scoutMissions ?? []).length}`,
    ...(competition.competitionId === null ? {} : { competitionId: competition.competitionId }),
    ...(position === undefined ? {} : { position }),
    ...(input.minAge === undefined ? {} : { minAge: input.minAge }),
    ...(input.maxAge === undefined ? {} : { maxAge: input.maxAge }),
    ...(input.maxValue === undefined ? {} : { maxValue: input.maxValue }),
    requestedOn: state.date,
    dueOn: null,
    completedOn: null,
  };

  const twin = [...activeMissions(state), ...waitingMissions(state)].find((m) =>
    sameMissionConditions(m, draft),
  );
  if (twin) {
    return {
      ok: false,
      message:
        twin.dueOn === null
          ? `같은 조건의 임무가 이미 대기 중입니다 (${missionLabel(twin)}) — 자리가 나면 나갑니다`
          : `같은 조건으로 이미 나가 있습니다 (${missionLabel(twin)}) — 보고 예정 ${twin.dueOn}`,
    };
  }

  const missions = (state.scoutMissions ??= []);
  if (freeScoutSlots(state) <= 0) {
    /**
     * 못 나갔다는 사실을 **표에 남긴다** — 반려 문구는 이 턴에만 살아 있어, 남기지
     * 않으면 다음 턴의 모델에는 이 임무를 읽을 자리가 없다 (player.md §9.4).
     * 자리가 나도 코어가 대신 보내지 않는다: 상태 전이는 명령 한 경로뿐이다.
     */
    missions.push(draft);
    return {
      ok: false,
      message:
        `${missionLabel(draft)} 임무는 보내지 못했습니다 — 동시 파견 한도 ` +
        `${SCOUT_CONCURRENT_LIMIT}이 차 있습니다 (파견 중: ${inFlightScoutLabels(state).join(", ")}). ` +
        `${earliestScoutReturn(state)} 보고가 들어오면 자리가 납니다. ` +
        `이 임무는 대기로 남습니다 — 자리가 난 뒤 다시 불러야 나갑니다`,
    };
  }

  const dueOn = addDays(state.date, MISSION_DAYS);
  const mission: ScoutMission = { ...draft, dueOn };
  // 대기하던 같은 조건은 위에서 걸러졌다 — 이 임무는 지금 처음 나간다
  missions.push(mission);
  /**
   * 파견은 아직 아무 장부도 바꾸지 않았다 — 지목과 같은 갈래(`kind: "scout"`)의
   * 카드로 선다. 이름 자리에는 조건이, 상대 자리에는 뒤지는 곳이 온다.
   */
  const card: MarketCard = {
    kind: "scout",
    playerId: mission.id,
    playerName: missionBrief(mission),
    counterpart: missionScope(mission),
    direction: "in",
    dueOn,
    note: `후보 ${MISSION_CANDIDATES}명`,
  };
  return {
    ok: true,
    payload: card,
    message:
      `스카우트 임무 파견 — ${missionLabel(mission)} · ` +
      `보고 예정 ${dueOn} (후보 ${MISSION_CANDIDATES}명)`,
  };
}
