import type { GamePlayer } from "@story-fm/domain";
import { formLabel } from "./form";
import { isSettling } from "./settling";
import { diffDays } from "./calendar";
import { openInjury, playersOf, squadLevelOf, type GameState } from "./state";

/**
 * **선수 근황 — 세계에 지금 무슨 이야기가 있는가.**
 *
 * 상태 스냅샷이 이름을 내보내는 자리는 원래 부상·정지·불만뿐이었다. 그 셋은
 * 몇 주씩 바뀌지 않으므로, GM이 아는 "이야기가 있는 선수"는 늘 같은 두세 명이고
 * 나머지 서른 명은 이름·포지션만 적힌 표로만 존재한다. 그래서 한 번 말한 선수가
 * 계속 말한다 — 모델이 게을러서가 아니라 **다른 선수를 세울 근거가 없어서**다.
 *
 * 여기서 코어가 내놓는 것은 **사실뿐**이다(approaches.md §1 · press.ts와 같은 결).
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

/** 최근 우리 경기의 출전 명단 — 새 경기가 앞에 온다 */
function recentLineups(state: GameState, limit: number): Array<ReadonlySet<string>> {
  return state.matches
    .filter((m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId)
    .filter((m) => m.result !== null)
    .slice(-limit)
    .reverse()
    .map((m) => {
      const home = m.homeTeamId === state.userTeamId;
      return new Set(m.result?.[home ? "homeLineup" : "awayLineup"] ?? []);
    });
}

/**
 * **최근에 말한 사람은 뒤로 민다.**
 *
 * 회전의 핵심이 여기다. 근황이 있다는 사실만으로 고르면 폼이 절정인 선수는
 * 그 상태가 이어지는 몇 주 내내 후보 맨 앞에 서고, 그 사이 다른 선수는 한 번도
 * 차례가 오지 않는다. 지우지 않고 미는 이유는 어제 말한 선수라도 오늘 부상에서
 * 돌아왔으면 그게 더 큰 사건이기 때문이다.
 */
function recentSpeakers(state: GameState, turns: number): ReadonlySet<string> {
  const names = new Set<string>();
  const models = state.chat.filter((t) => t.role === "model").slice(-turns);
  for (const turn of models) {
    for (const line of turn.text.split("\n")) {
      const match = line.match(/^@([^:]+):/u);
      if (match) names.add(match[1]!.trim());
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
  const spoke = recentSpeakers(state, 6);
  const cues: Array<SpeakerCue & { rank: number }> = [];

  for (const player of playersOf(state, state.userTeamId)) {
    if (squadLevelOf(player) !== "first") continue;
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
      rank: spoke.has(player.name) ? 1 : 0,
    });
  }
  if (cues.length === 0) return [];

  cues.sort((a, b) => (a.rank === b.rank ? (a.playerId < b.playerId ? -1 : 1) : a.rank - b.rank));
  /**
   * 아직 말하지 않은 후보들을 **날짜로 굴린다** — 근황은 며칠씩 그대로라 정렬만으로는
   * 같은 이름이 몇 주 내내 맨 앞이다. 시드가 아니라 날짜인 이유: 같은 날 같은 세이브면
   * 같은 목록이어야 한다(하루 안의 회전은 "최근에 말한 사람"이 맡는다).
   */
  const day = diffDays(EPOCH, state.date);
  const fresh = cues.filter((c) => c.rank === 0);
  const spoken = cues.filter((c) => c.rank !== 0);
  const rotated = fresh.map((_, i) => fresh[(i + day) % fresh.length]!);
  return [...rotated, ...spoken].slice(0, limit).map(({ playerId, name, fact }) => ({
    playerId,
    name,
    fact,
  }));
}
