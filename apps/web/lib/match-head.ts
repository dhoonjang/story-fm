import { formatScore } from "@story-fm/domain";
import type { ChatTurn } from "@story-fm/engine";
import type { MatchLogHead, MatchLogTeam } from "./store";

/**
 * ── 경기 머리의 사실 한 벌 ─────────────────────────────────
 *
 * **같은 경기의 머리를 두 자리가 그린다** — 채팅에 접힌 경기 카드와 종료 카드다.
 * 코어가 싣는 것은 값뿐이고(`matchLogs` — match.md §8), 「홈 · 프라이부르크」도
 * 「2 – 1」도 「승」도 여기서 조립한다. 두 자리가 각자 조립하면 같은 경기가 두 얼굴을
 * 갖는다.
 *
 * 종료 카드가 이 사실을 읽는 이유는 **리포트를 기다리지 않기 위해서다**: 스코어와
 * 골은 이미 화면에 와 있는데(접힌 경기 머리 · 턴의 사건 표식) 그것까지 요청에 걸어
 * 두면 휘슬 뒤 첫 화면이 스켈레톤 두 줄이 된다.
 */
export interface MatchHeadFacts {
  home: MatchLogTeam;
  away: MatchLogTeam;
  date: string;
  score: { home: number; away: number; penalties?: { home: number; away: number } };
  /** 우리 시점의 결과 — 우리 경기가 아니면 null */
  outcome: "W" | "D" | "L" | null;
  /** 이 경기의 골 — 분 순서. 리포트가 닿기 전의 「주요 사건」이 읽는다 */
  goals: MatchHeadGoal[];
}

export interface MatchHeadGoal {
  minute: number;
  scorer: string;
  assist: string | null;
  ours: boolean;
  side: "home" | "away";
}

/** 우리 시점의 대진 한 줄 — 「홈 · 프라이부르크」. 남의 경기는 「아스날 – 첼시」 */
export function matchTitleOf(log: MatchLogHead): string {
  if (log.home.ours) return `홈 · ${log.away.name}`;
  if (log.away.ours) return `원정 · ${log.home.name}`;
  return `${log.home.name} – ${log.away.name}`;
}

/** 스코어 표기 — 자는 `formatScore` 하나다 (design-system.md §3). 결과 전이면 null */
export function matchScoreOf(log: MatchLogHead): string | null {
  return log.score === null
    ? null
    : formatScore(log.score.home, log.score.away, log.score.penalties);
}

/** 결과어 — 승/무/패. 승부차기가 갈린 경기는 **본 스코어가 아니라 킥이 정한다** */
export function outcomeWordOf(outcome: "W" | "D" | "L" | null): string | null {
  return outcome === null ? null : outcome === "W" ? "승" : outcome === "D" ? "무" : "패";
}

function outcomeFrom(
  ours: "home" | "away" | null,
  score: NonNullable<MatchLogHead["score"]>,
): "W" | "D" | "L" | null {
  if (ours === null) return null;
  const pens = score.penalties;
  const [mine, theirs] =
    ours === "home"
      ? [pens?.home ?? score.home, pens?.away ?? score.away]
      : [pens?.away ?? score.away, pens?.home ?? score.home];
  return mine > theirs ? "W" : mine < theirs ? "L" : "D";
}

/**
 * 이 경기의 머리 사실 — 결과가 아직 없으면 null (진행 중인 경기는 머리가 없다).
 *
 * 골은 **장부의 사건 표식**(`ChatTurn.goals`)에서 모은다 — 중계 문장을 읽어낸 것이
 * 아니라 코어가 턴에 함께 남긴 값이라, 채팅의 골 카드와 여기가 같은 목록이다.
 */
export function matchHeadFacts(
  log: MatchLogHead,
  chat: readonly ChatTurn[],
  matchId: string,
): MatchHeadFacts | null {
  if (log.score === null) return null;
  const ours = log.home.ours ? "home" : log.away.ours ? "away" : null;
  const goals: MatchHeadGoal[] = [];
  for (const turn of chat) {
    if (turn.matchId !== matchId) continue;
    for (const goal of turn.goals ?? []) {
      goals.push({
        minute: goal.minute,
        scorer: goal.scorer,
        assist: goal.assist,
        ours: goal.ours,
        // 표식이 아는 것은 넣은 팀 이름이다 — 좌우 자리는 홈 기준이라 이름으로 가른다
        side: goal.team === log.home.name ? "home" : "away",
      });
    }
  }
  goals.sort((a, b) => a.minute - b.minute);
  return {
    home: log.home,
    away: log.away,
    date: log.date,
    score: log.score,
    outcome: outcomeFrom(ours, log.score),
    goals,
  };
}
