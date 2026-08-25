import type { GamePlayer } from "@story-fm/domain";
import { isReserveMatch, normalizeSpeaker } from "@story-fm/domain";
import { formLabel } from "./form";
import { isSettling } from "./settling";
import { diffDays } from "../competition/calendar";
import { pendingApproach } from "../club/approach";
import { openInjury, playersOf, squadLevelOf, type GameState } from "../core/state";

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

/** 이 선수에게 지금 있는 일 — 없으면 null */
function factOf(state: GameState, player: GamePlayer, benched: number): string | null {
  const injury = openInjury(state, player.id);
  if (injury) {
    return diffDays(state.date, injury.expectedReturn) <= RETURN_SOON
      ? `복귀 임박 (${injury.bodyPart}~${injury.expectedReturn})`
      : null; // 재활 초입은 이미 주의 줄의 부상 항목이 말한다
  }
  if (isSettling(state, player.id)) return "새 영입, 아직 적응 중";
  const form = player.state.form;
  if (form >= PEAK) return `폼 ${formLabel(form)}`;
  if (form <= SLUMP) return `폼 ${formLabel(form)}`;
  if (benched >= BENCHED_RUN) return `${benched}경기 연속 명단 제외`;
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
    const fact = factOf(state, player, benched);
    if (fact === null) continue;
    cues.push({
      playerId: player.id,
      name: player.name,
      fact,
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
