/**
 * 도착한 스카우트 보고서를 카드로 꺼내는 자리 — **꺼내는 자리는 평시 턴 하나다.**
 *
 * 줄에서 꺼낸 것과 카드로 선 것이 갈리면 보고서가 없어진다
 * (docs/data/player.md §9.4-1 · docs/llm/agents.md §6). 규칙과 상한(`MAX_REPORT_CARDS`)이
 * 한 자리에 살아야 그 짝이 어긋나지 않으므로, 조립·상한·빈 자리 표식을 이 모듈이 함께
 * 갖는다.
 */
import {
  consumeReportCards,
  missionReportCard,
  peekReportCards,
  scoutReportCard,
  type GameState,
} from "@story-fm/engine";
import type { MissionReportCard, ScoutReportCard } from "@story-fm/domain";

/** 한 턴에 세우는 스카우팅 보고서 카드 상한 — 화면이 카드로 덮이면 장면이 안 읽힌다 */
export const MAX_REPORT_CARDS = 3;

/** 이번 턴에 도착한 카드 — 지목의 보고서와 임무의 후보 목록이 한 줄에서 나온다 */
export interface ArrivedCards {
  reports: ScoutReportCard[];
  missions: MissionReportCard[];
}

/** 꺼낼 줄이 없는 턴 — 경기 중이거나 시계가 안 돌았다 */
export const NO_CARDS: ArrivedCards = { reports: [], missions: [] };

/**
 * 카드로 세울 보고서를 줄에서 꺼낸다 — **꺼낸 그 턴의 입력이 같은 값을 싣는다.**
 *
 * 코어가 장면보다 먼저 구른 턴(손잡이)은 그 사이 벌어진 일이, 장면 뒤에 구른
 * 턴(모델 헤더)은 다음 턴의 도착 블록이 그 값을 싣는다. 어느 쪽이든 카드가 붙은
 * 턴의 모델은 금액을 읽었다 (agents.md §6).
 *
 * ⚠️ **줄에서 빠지는 것은 카드가 실제로 선 것뿐이다.** 조립이 `null`을 주면(그 사이
 * 은퇴해 `state.players`에서 빠진 선수) 그 id는 줄에 남고 `stuck`에 적혀 이번 턴에
 * 다시 집히지 않는다 — 영영 못 세울 것은 tick의 `pruneReportCards`가 사실을 남기며
 * 닫는다. 꺼내면서 지우면 며칠을 기다려 산 보고서가 화면에 한 번도 안 뜨고, 사무실에
 * 스카우팅 화면이 없어 되찾을 자리도 없다 (player.md §9.4-1).
 *
 * ⚠️ **줄은 한 번에 갈래를 가른다.** 도착 줄(`pendingReportCards`)에는 지목의 선수
 * id와 임무 id가 섞여 온다 — 갈래마다 따로 꺼내면 앞의 호출이 줄을 비워 뒤는 언제나
 * 빈손이다. 임무 표(`state.scoutMissions`)에서 찾히는 id가 임무다.
 */
export function takeArrivedReports(
  state: GameState,
  limit: number,
  stuck: Set<string> = new Set(),
): ArrivedCards {
  const missionIds = new Set((state.scoutMissions ?? []).map((m) => m.id));
  const cards: ArrivedCards = { reports: [], missions: [] };
  const stood: string[] = [];
  for (const id of peekReportCards(state, limit, stuck)) {
    const mission = missionIds.has(id) ? missionReportCard(state, id) : null;
    const report = missionIds.has(id) ? null : scoutReportCard(state, id);
    if (mission) cards.missions.push(mission);
    else if (report) cards.reports.push(report);
    else {
      stuck.add(id);
      continue;
    }
    stood.push(id);
  }
  consumeReportCards(state, stood);
  return cards;
}
