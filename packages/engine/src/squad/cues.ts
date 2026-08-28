import type { CallUp, GamePlayer } from "@story-fm/domain";
import {
  capsOf,
  INTEREST_STAGE_KO,
  isReserveMatch,
  naturalPositionOf,
  normalizeSpeaker,
  numberWishOf,
  pressFactText,
  TRANSFER_REQUEST_REASON_KO,
} from "@story-fm/domain";
import { formLabel } from "./form";
import { isSettling } from "./settling";
import { openSymbolicNumbers, type NumberLineage } from "./numbers";
// 심경(mood)과 같은 문을 지난다 — 두 벌이면 같은 사이가 자리마다 다른 말로 선다
import { mentoringReadOf } from "./mentoring";
import { diffDays } from "../competition/calendar";
import { daysUntilReturn, internationalBreaksOf, openCallUp } from "../competition/international";
import { playerArchetypeOf } from "../world/player-persona";
// 근황 줄 끝에 수용성 사실이 선다 — 판정 근거 (c)를 읽을 자리다 (career.md §2)
import { receptivityLine, receptivityOf } from "./receptivity";
import {
  announcedInterestsOn,
  openInjury,
  pendingApproach,
  playersOf,
  squadLevelOf,
  teamNameIn,
  transferRequestOf,
  type GameState,
} from "../core/state";

/**
 * **선수 근황 — 세계에 지금 무슨 이야기가 있는가.**
 *
 * 상태 스냅샷이 이름을 내보내는 자리는 원래 부상·정지·불만뿐이었다. 그 셋은
 * 몇 주씩 바뀌지 않으므로, GM이 아는 "이야기가 있는 선수"는 늘 같은 두세 명이고
 * 나머지 서른 명은 이름·포지션만 적힌 표로만 존재한다. 그래서 한 번 말한 선수가
 * 계속 말한다 — 모델이 게을러서가 아니라 **다른 선수를 세울 근거가 없어서**다.
 *
 * 여기서 코어가 내놓는 것은 **사실뿐**이다(overview.md §1 철칙 4 · press.ts와 같은 결).
 * "누가 말해야 한다"도, 그 사람이 할 말도 정하지 않는다 — 장면을 여는 사람은
 * 그 일에 가장 가까운 사람이라는 규칙이 프롬프트에 이미 있고, 문장은 GM이 쓴다.
 */

export interface SpeakerCue {
  playerId: string;
  name: string;
  /** 지금 이 선수에게 있는 일 — 사실 한 조각 */
  fact: string;
}

/** 폼이 이야기가 되는 경계 — 이 안쪽은 "평소"라 말할 거리가 아니다 */
const PEAK = 0.5;
const SLUMP = -0.4;
/** 이만큼 연속으로 명단에 못 들면 본인에게 사건이다 */
const BENCHED_RUN = 3;
/** 복귀가 눈앞인 부상 — 재활 막바지의 이야기 */
const RETURN_SOON = 14;
/** 대표팀에서 돌아온 뒤 그 사실이 그의 이야기인 기간 — 「돌아온 주」다 (people.md §7) */
const BACK_FROM_DUTY = 7;
/** 회전의 기준점 — 날짜를 수로 바꾸기만 하는 자리라 값 자체에 뜻은 없다 */
const EPOCH = "2000-01-01";

/**
 * 최근 이만큼의 모델 턴에 이름이 섰으면 뒤로 민다 — 근황과 코치의 눈이 **같은 창**을
 * 본다. 창이 둘이면 한쪽에서 밀린 이름이 다른 쪽에서 그대로 맨 앞에 선다.
 */
export const CUE_ROTATION_TURNS = 6;

/**
 * 날짜를 회전 눈금으로 — 시드가 아니라 날짜인 이유는 같은 날 같은 세이브면 같은
 * 목록이어야 해서다(하루 안의 회전은 "최근에 말한 사람"이 맡는다).
 */
export function rotationDay(date: string): number {
  return diffDays(EPOCH, date);
}

/**
 * 최근 우리 경기의 출전 명단 — 새 경기가 앞에 온다.
 *
 * ⚠️ **최근은 날짜로 정한다.** `state.matches`는 날짜순이 아니다 — 컵·대항전 대진은
 * 그 라운드가 확정될 때 배열 **뒤에** 붙으므로, 배열 끝 세 원소는 시즌 후반이면
 * 방금 편성된 컵 경기다. 그것으로 세면 리그 3연속 명단 제외가 조용히 새어 나간다
 * (`mood.ts`·`slump.ts`도 같은 이유로 날짜순이다).
 */
function recentLineups(state: GameState, limit: number): Array<ReadonlySet<string>> {
  return (
    state.matches
      .filter((m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId)
      // 2군 경기 명단은 1군 명단 제외의 근거가 아니다 — 1군 전원이 "제외"로 읽힌다
      .filter((m) => m.result !== null && !isReserveMatch(m))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, limit)
      .map((m) => {
        const home = m.homeTeamId === state.userTeamId;
        return new Set(m.result?.[home ? "homeLineup" : "awayLineup"] ?? []);
      })
  );
}

/**
 * **최근에 말한 사람은 뒤로 민다.**
 *
 * 회전의 핵심이 여기다. 근황이 있다는 사실만으로 고르면 폼이 절정인 선수는
 * 그 상태가 이어지는 몇 주 내내 후보 맨 앞에 서고, 그 사이 다른 선수는 한 번도
 * 차례가 오지 않는다. 지우지 않고 미는 이유는 어제 말한 선수라도 오늘 부상에서
 * 돌아왔으면 그게 더 큰 사건이기 때문이다.
 *
 * ⚠️ 이름은 `normalizeSpeaker`로 맞춘 뒤 견준다 — 모델은 같은 사람을 "스티브 홀랜드"로도
 * "스티브홀랜드"로도 쓴다. 원문 그대로 견주면 공백 하나가 다른 순간 방금 말한 선수가
 * 회전에서 빠져 계속 맨 앞에 선다 (people.md §1과 같은 규칙 · 부분 일치는 하지 않는다).
 *
 * 수석코치의 눈(`coach-cues.ts`)도 같은 이 함수로 회전한다 — 두 벌이면 한쪽만
 * 고쳐져 같은 이름이 근황에서는 밀리고 코치의 카드에서는 안 밀린다.
 */
export function recentSpeakers(state: GameState, turns: number): ReadonlySet<string> {
  const names = new Set<string>();
  const models = state.chat.filter((t) => t.role === "model").slice(-turns);
  for (const turn of models) {
    for (const line of turn.text.split("\n")) {
      const match = line.match(/^@([^:]+):/u);
      if (match) names.add(normalizeSpeaker(match[1]!));
    }
  }
  return names;
}

/**
 * **비어 있는 상징 번호가 이 선수의 근황인가** (people.md §7 · §6).
 *
 * 카드는 **원하는 선수에게** 선다 — 팀에 걸린 사실을 한 사람의 근황 줄에 싣지
 * 않는다. 원형이 그 번호를 **첫 지망**으로 부를 때만이다: 둘째 지망까지 세우면
 * 자리에 상징 번호가 셋인 윙어가 공석 하나마다 근황을 갖는다.
 *
 * 우상(`idol`)이 고르는 표는 **비어 있는 번호들의 계보를 이은 것**이다 — 그가
 * 물려받을 수 있는 번호가 지금 그것들뿐이라, 주인이 있는 번호의 계보를 함께 주면
 * 서지도 못할 번호가 첫 지망이 된다.
 */
function openNumberFor(
  state: GameState,
  player: GamePlayer,
  open: readonly NumberLineage[],
): NumberLineage | null {
  if (open.length === 0) return null;
  const wish = numberWishOf(
    playerArchetypeOf(state.seed, player),
    { position: naturalPositionOf(player).position, squadNumber: player.squadNumber },
    open.flatMap((lineage) => lineage.past),
  );
  const first = wish?.numbers[0];
  if (first === undefined) return null;
  return open.find((lineage) => lineage.number === first) ?? null;
}

/** 그가 가장 최근에 돌아온 소집 — 아직 정산되지 않은 행은 소집 중이라 여기 오지 않는다 */
function lastCallUpReturn(state: GameState, playerId: string): CallUp | null {
  let latest: { row: CallUp; on: string } | null = null;
  for (const row of state.callUps ?? []) {
    if (row.gamePlayerId !== playerId || row.returnedOn === null) continue;
    if (latest === null || row.returnedOn > latest.on) latest = { row, on: row.returnedOn };
  }
  return latest?.row ?? null;
}

/**
 * **대표팀 소집·복귀** (competition.md §5-1) — 소집 중이면 클럽에 아예 없고, 돌아온
 * 주에는 그 창의 출전·골과 몸이 그의 이야기다.
 *
 * 문장은 `pressFactText`가 만든다 — 회견·다가옴과 같은 카드라, 두 벌을 두면 같은
 * 소집이 근황에서와 회견에서 다른 말로 선다 (people.md §7).
 */
function callUpFactOf(state: GameState, player: GamePlayer): string | null {
  const away = openCallUp(state, player.id);
  if (away) {
    const breakWindow = internationalBreaksOf(state.season).find((w) => w.key === away.breakKey);
    return pressFactText({
      kind: "call-up",
      data: {
        tags: ["named", away.country],
        values: {
          caps: capsOf(player.state),
          ...(breakWindow ? { days: daysUntilReturn(state, breakWindow) } : {}),
        },
      },
      about: player.id,
      sharp: false,
    });
  }
  const back = lastCallUpReturn(state, player.id);
  const returnedOn = back?.returnedOn ?? null;
  if (back === null || returnedOn === null) return null;
  if (diffDays(returnedOn, state.date) > BACK_FROM_DUTY) return null;
  return pressFactText({
    kind: "call-up",
    data: {
      tags: ["returned", back.country, ...(back.returnState ? [back.returnState] : [])],
      values: { apps: back.apps, goals: back.goals },
    },
    about: player.id,
    sharp: false,
  });
}

/** 이 선수에게 지금 있는 일 — 없으면 null */
function factOf(
  state: GameState,
  player: GamePlayer,
  benched: number,
  openNumbers: readonly NumberLineage[],
): string | null {
  /**
   * **이번 시즌 뒤 은퇴** — 맨 앞이다 (people.md §7 · season.md §6). 폼도 명단 제외도
   * 그 사실 위에서 읽히므로, 뒤로 밀면 마지막 시즌을 보내는 선수가 「3경기 명단 제외」로만
   * 세계에 선다.
   */
  const retiring = player.state.retiringAfterSeason;
  if (retiring) return `이번 시즌 뒤 은퇴 (${retiring.on} 예고)`;
  const injury = openInjury(state, player.id);
  if (injury) {
    return diffDays(state.date, injury.expectedReturn) <= RETURN_SOON
      ? `복귀 임박 (${injury.bodyPart}~${injury.expectedReturn})`
      : null; // 재활 초입은 이미 주의 줄의 부상 항목이 말한다
  }
  /**
   * **대표팀은 뛸 수 없는 것 다음이고 나가겠다는 말보다 앞이다** (people.md §7).
   * 소집 중인 선수는 이번 주 클럽에 없다 — 그 사실 위에서 폼도 명단도 읽힌다.
   */
  const duty = callUpFactOf(state, player);
  if (duty) return duty;
  /**
   * **나가겠다고 말한 것은 폼보다 큰 사실이다** (transfer.md §1-1) — 뛸 수 없는 것
   * 다음이고 나머지보다는 앞이다. 수락한 요청은 서지 않는다: 그 사실은 이적
   * 리스트가 이미 말한다.
   */
  const request = transferRequestOf(state, player.id);
  if (request && request.answer !== "accept") {
    const reason = TRANSFER_REQUEST_REASON_KO[request.reason];
    return `이적 요청 (${reason}) — ${request.answer === "refuse" ? "감독이 거부했다" : "아직 답하지 않았다"}`;
  }
  /**
   * **밖에서 묻는 것은 나가겠다고 말한 것보다는 뒤고 나머지보다는 앞이다**
   * (transfer.md §1-2 · people.md §7). `watching`은 서지 않는다 — 아직 아무 말도
   * 오지 않은 것이라 라커룸에 들릴 사실이 없다. 맨 앞 줄(사다리 위 칸)만 쓴다:
   * 두 구단을 다 적으면 근황 한 조각이 시장 브리핑이 된다.
   */
  const interest = announcedInterestsOn(state, player.id)[0];
  if (interest) {
    return `${teamNameIn(state, interest.teamId)} 관심 — ${INTEREST_STAGE_KO[interest.stage]}`;
  }
  if (isSettling(state, player.id)) return "새 영입, 아직 적응 중";
  const form = player.state.form;
  if (form >= PEAK) return `폼 ${formLabel(form)}`;
  if (form <= SLUMP) return `폼 ${formLabel(form)}`;
  if (benched >= BENCHED_RUN) return `${benched}경기 연속 명단 제외`;
  /**
   * **멘토링** — 번호와 함께 맨 뒤다 (people.md §7). 지금 벌어지는 일이 아니라 그 밑에
   * 깔린 **서 있는 사이**라, 끝난 사이는 여기 오지 않는다: 그것은 심경의 자리이고
   * (§5) 근황은 「지금 세계에 무슨 이야기가 있는가」다.
   */
  const mentoring = mentoringReadOf(state, player.id);
  if (mentoring && mentoring.pair.until === undefined && mentoring.other) {
    return mentoring.side === "mentor"
      ? `${mentoring.other.name}을(를) 데리고 있다 (멘토 · ${mentoring.days}일째` +
          `${mentoring.count > 1 ? ` · ${mentoring.count}명` : ""})`
      : `${mentoring.other.name}에게 붙어 있다 (멘티 · ${mentoring.days}일째)`;
  }
  /**
   * **사실 열 중 마지막이다** — 뛰지 못하는 것도 나가겠다는 말도 폼도 지금
   * 벌어지는 일이고, 비어 있는 번호는 그 밑에 깔린 사정이다.
   *
   * 문장은 `pressFactText`가 만든다 — 회견·다가옴과 **같은 카드**라, 두 벌을 두면
   * 같은 계보가 근황에서와 회견에서 다른 말로 선다 (people.md §7).
   */
  const open = openNumberFor(state, player, openNumbers);
  if (open) {
    const after = open.past[0];
    return pressFactText({
      kind: "number-open",
      data: {
        ...(after === undefined ? {} : { name: after.name }),
        values: {
          number: open.number,
          ...(after === undefined
            ? {}
            : { seasons: after.seasons, since: state.season - after.lastSeason }),
        },
      },
      about: player.id,
      sharp: false,
    });
  }
  return null;
}

/**
 * 오늘 이야기가 있는 선수들 — **1군만**, 최대 `limit`명.
 *
 * 2군은 감독의 일상에 닿지 않아 근황이 장면이 되지 않는다(승격은 감독이 먼저
 * 손을 뻗는 일이다). 결정적이다 — 같은 날 같은 세이브면 같은 목록이다.
 */
export function speakerCues(state: GameState, limit = 3): SpeakerCue[] {
  const lineups = recentLineups(state, BENCHED_RUN);
  const spoke = recentSpeakers(state, CUE_ROTATION_TURNS);
  /**
   * ⚠️ **한 번만 센다.** 계보는 시즌 기록 전체를 훑어 파생하므로, 1군 전원 루프
   * 안에서 부르면 같은 원장을 사람 수만큼 다시 읽는다 (`recentLineups`·`spoke`와
   * 같은 이유로 밖에서 선다).
   */
  const openNumbers = openSymbolicNumbers(state, state.userTeamId);
  const cues: Array<SpeakerCue & { rank: number }> = [];

  /**
   * **이미 감독 앞에 서 있는 사람은 근황이 아니다** (people.md §8). 코어가 그 선수로
   * 자리를 열어 놓고 근황 줄로 같은 이름을 다시 밀면, 모델은 같은 이야기를 두 번
   * 열거나 둘 중 하나를 버린다.
   */
  const atTheDoor = pendingApproach(state)?.about ?? null;

  for (const player of playersOf(state, state.userTeamId)) {
    if (squadLevelOf(player) !== "first") continue;
    if (player.id === atTheDoor) continue;
    let benched = 0;
    for (const lineup of lineups) {
      if (lineup.has(player.id)) break;
      benched += 1;
    }
    const fact = factOf(state, player, benched, openNumbers);
    if (fact === null) continue;
    cues.push({
      playerId: player.id,
      name: player.name,
      fact: `${fact} · ${receptivityLine(receptivityOf(state, player.id))}`,
      // 최근에 말한 사람은 뒤로 — 그 안에서는 날짜로 회전한다
      rank: spoke.has(normalizeSpeaker(player.name)) ? 1 : 0,
    });
  }
  if (cues.length === 0) return [];

  cues.sort((a, b) => (a.rank === b.rank ? (a.playerId < b.playerId ? -1 : 1) : a.rank - b.rank));
  /**
   * 아직 말하지 않은 후보들을 **날짜로 굴린다** — 근황은 며칠씩 그대로라 정렬만으로는
   * 같은 이름이 몇 주 내내 맨 앞이다.
   */
  const day = rotationDay(state.date);
  const fresh = cues.filter((c) => c.rank === 0);
  const spoken = cues.filter((c) => c.rank !== 0);
  const rotated = fresh.map((_, i) => fresh[(i + day) % fresh.length]!);
  return [...rotated, ...spoken].slice(0, limit).map(({ playerId, name, fact }) => ({
    playerId,
    name,
    fact,
  }));
}
