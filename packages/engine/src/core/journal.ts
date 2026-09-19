import type {
  BoardPoint,
  MatchEvent,
  MatchStatLine,
  Point,
  SheetLine,
  ShootoutKick,
  TacticsSpec,
  TickEvent,
} from "@story-fm/domain";
import { clockOf, type CommandBrief, type GameState } from "./state";
import type { PacketDigest } from "../match/packet-digest";

/**
 * **사실의 문** — 코어가 한 턴에 한 일을 밖으로 내는 유일한 자리 (models.md §5-3).
 *
 * 세이브는 장부의 **지금**이고, 호출 원문은 모델이 **본 것과 답한 것**이다. 그 사이 —
 * 해석기가 낸 명령, 코어가 건 것과 반려한 것, 판이 구른 패킷과 난수 채널, 사건, 굴러간
 * 하루하루 — 는 어디에도 남지 않았다. 프롬프트 안의 문장을 정규식으로 긁어 세는 것이
 * 「왜 그랬나」에 답하는 길이어서는 안 된다. 그래서 일어난 자리에서 **구조로** 낸다.
 *
 * ## 쓰기 전용이고, 기본값은 아무것도 하지 않는다
 *
 * 엔진은 사실을 내기만 하고 어디에 앉는지 모른다. 앉히는 것은 창고
 * (`@story-fm/llm`의 `turn-trace.ts`)이고 잇는 자리는 웹의 `turn-runner`다(`bindJournal`).
 * 이 패키지는 창고를 모른다 — 알면 순환이고, 알 필요도 없다. **게임 로직이 여기서 값을
 * 읽는 일은 없다**: 기록이 꺼진 프로세스(production·CLI·하네스)와 켜진 프로세스가 같은
 * 세이브에서 같은 결과를 내야 한다.
 *
 * ## 사실은 코드다
 *
 * 사건은 `MatchEvent` 그대로, 키포인트는 `PacketTag` 그대로 싣는다. 문장을 적으면 문구를
 * 고친 날 옛 기록의 집계가 깨진다 — 문장은 읽는 쪽이 같은 렌더러로 만든다.
 */

/** 창고가 받는 것 — 갈래(`kind`)와 그 갈래의 값. 창고는 여기에 순서와 시각을 얹는다 */
export type JournalEntry =
  | {
      kind: "match.kickoff";
      matchId: string;
      competitionId: string | null;
      stage: string | null;
      round: number | null;
      neutral: boolean;
      derby: { name: string; heat: number } | null;
      userSide: "home" | "away";
      home: KickoffSide;
      away: KickoffSide;
      /** 부상·정지로 자동 대체된 우리 선수 */
      replaced: string[];
      /** 이 경기에 정지를 소화하는 우리 선수 */
      serving: string[];
      packet: PacketDigest;
    }
  | {
      kind: "match.segment";
      matchId: string;
      /** 몇 번째 구간인가 — 난수 채널에 들어가는 그 수 */
      segment: number;
      /** 이 구간을 굴린 난수 채널 — 시드와 함께면 같은 구간이 다시 구른다 */
      channel: string;
      staminaKey: string;
      untilMinute: number | null;
      from: { minute: number; clock: number | null };
      to: { minute: number; clock: number };
      stop: string;
      score: { before: { home: number; away: number }; after: { home: number; away: number } };
      phase: string;
      /** 상대 벤치가 이 구간 앞에서 판을 옮겼는가 */
      aiShift: boolean;
      aiSubs: number;
      events: MatchEvent[];
      stats: Record<string, MatchStatLine>;
      /** 선수 id → 이 구간에 쌓인 피로 */
      fatigue: Record<string, number>;
      /** 이 구간이 **실제로 구른** 패킷 — 상대의 전환이 반영된 뒤의 것 */
      packet: PacketDigest;
    }
  | {
      kind: "match.shootout";
      matchId: string;
      kick: ShootoutKick | null;
      tally: { home: number; away: number };
      done: boolean;
    }
  | {
      kind: "match.ruling";
      matchId: string;
      applied: number;
      skipped: number;
      already: boolean;
      /** 선수마다 — 모델이 준 값 · 코어 앵커 · 한도로 자른 값 */
      entries: Array<{ playerId: string; given: number; anchor: number; bounded: number }>;
    }
  | {
      kind: "match.finalized";
      matchId: string;
      competitionId: string | null;
      score: { home: number; away: number };
      outcome: "win" | "draw" | "loss";
      shots: { home: number; away: number };
      xg: { home: number; away: number };
      expectedGoals: { home: number; away: number };
      possession: { home: number; away: number } | null;
      aet: boolean;
      penalties: { home: number; away: number } | null;
      /** 코어 앵커 평점 — 모델의 판정은 `match.ruling`이 갖는다 */
      ratings: Record<string, number>;
      /** 선수 id → 이 경기가 실제로 가져간 체력 */
      fatigue: Record<string, number>;
      digest: { ours: string[]; finance: string[]; others: string[] };
    }
  | {
      kind: "tick.day";
      date: string;
      events: TickEvent[];
      /** 이 날 소화된 훈련 세션 수 */
      trained: number;
      /** 이 날에서 시계가 선 이유 — 계속 갔으면 null */
      stopped: string | null;
    }
  | {
      kind: "tick.match";
      matchId: string;
      competitionId: string | null;
      stage: string | null;
      round: number | null;
      date: string;
      reserve: boolean;
      home: string;
      away: string;
      score: { home: number; away: number };
      shots: { home: number; away: number };
      xg: { home: number; away: number };
      expectedGoals: { home: number; away: number };
      possession: { home: number; away: number };
      injuries: number;
      cards: number;
      subs: number;
      /** 간이 시뮬의 난수 키 — 시드와 함께면 같은 경기가 다시 구른다 */
      key: string;
    }
  | { kind: "tick.season_end"; season: number; lines: string[] }
  | {
      kind: "command";
      name: string;
      input: unknown;
      ok: boolean;
      message: string;
      /** 어느 문으로 왔나 — 모델·해석기가 지나는 `wrap`인가, 화면의 전술판인가 */
      source: "tool" | "board";
      /** 부르기 전에 막힌 이유 — 인자 검증 실패 · 무직 */
      blocked?: "input" | "dismissed";
      unchanged?: boolean;
      tone?: "good" | "bad";
      brief?: CommandBrief;
      payload?: unknown;
    }
  | {
      kind: "orders.intent";
      /** 설정·기록·재시도가 함께 쓰는 하나의 이름 — 도구 이름은 없다 (models.md §3-2) */
      agent: string;
      /** 감독의 말 원문 — 해석기에 들어간 그것 */
      raw: string | null;
      ok: boolean;
      ops?: Record<string, unknown[]>;
      truncated?: Record<string, number>;
      unresolved?: string;
      /** 산출을 쓸 수 없어 한 번 더 불렀는가 */
      retried: boolean;
      /** 반려로 답한 이유 · 호출 자체의 실패 */
      message?: string;
      failure?: string;
    }
  | {
      /**
       * **판독기가 판을 읽었다** — 킥오프 · 지시 턴 · 구간 뒤 (match.md §1.6).
       * 포인트와 시트는 앉힌 그대로다 — 두 경기가 왜 달랐는지는 여기와 호출 원문이 답한다.
       */
      kind: "match.reading";
      occasion: "kickoff" | "orders" | "segment";
      ok: boolean;
      points: Point[];
      sheet: SheetLine[];
      /** 산출을 쓸 수 없어 한 번 더 불렀는가 */
      retried: boolean;
      /** 삼킨 실패 · 반려 — 판은 지난 판독 그대로다 */
      failure?: string;
    }
  | {
      kind: "orders.applied";
      notes: string[];
      rolled: boolean;
      shapeChanged: boolean;
      untilMinute: number | null;
      shootout: boolean;
    }
  | { kind: "llm.retry"; label: string; error: string }
  | { kind: "llm.anchor"; label: string; error: string }
  | {
      kind: "scene";
      inMatch: boolean;
      kickoff: boolean;
      /** 첫 줄 헤더 — 못 읽었으면 null */
      header: string | null;
      /** 경기 장면이 적은 분 · 장부의 분 */
      minute: number | null;
      ledgerMinute: number | null;
      /** 장면이 닿은 마지막 시점 */
      scenePoint: { date: string; clock: string } | null;
      clockSource: string | null;
      /** 시계를 실제로 옮긴 결과 — 옮길 것이 없었으면 null */
      moved: {
        from: { date: string; clock: string };
        to: { date: string; clock: string };
        short: boolean;
        stopped: string;
        events: number;
      } | null;
      /** 헤더를 연달아 못 읽어 멈춘 턴 수 — 문턱 아래면 null */
      stalled: number | null;
      /** 장면이 비어 코어 기록으로 세웠는가 */
      emptyScene: boolean;
      /** 코어가 대신 마감해 마무리 중계를 붙였는가 */
      closedByCore: boolean;
      /** 마지막 줄의 `<suggest_reply>`가 값을 냈는가 — 없거나 상한을 넘은 턴은 false */
      suggested: boolean;
      textChars: number;
    }
  | {
      kind: "history.compacted";
      folded: boolean;
      memories: number;
      characters: number;
      relations: number;
    }
  | { kind: "warn"; where: string; text: string; detail?: string };

/** 킥오프 한쪽 — 명단·전술·벤치의 감독 */
export interface KickoffSide {
  teamId: string;
  onPitch: string[];
  bench: string[];
  tactics: TacticsSpec;
  managerTactics: number;
}

export type JournalKind = JournalEntry["kind"];

export type JournalSink = (entry: JournalEntry) => void;

let sink: JournalSink | null = null;

/**
 * 창고가 스스로를 잇는 자리 — 프로세스에 하나다. `null`이면 사실은 버려진다.
 *
 * 프로세스 전역이어도 두 게임의 턴이 섞이지 않는 것은 창고 쪽의 일이다: 창고는 열린
 * 턴 범위(`AsyncLocalStorage`)를 보고 앉히므로, 여기 걸린 함수는 자리를 정하지 않는다.
 */
export function bindJournal(next: JournalSink | null): void {
  sink = next;
}

/**
 * 사실 하나를 낸다 — 앉을 창고가 없으면 아무 일도 없다.
 *
 * ⚠️ 창고가 던져도 게임은 간다. 기록은 결과가 아니다 — 디스크가 차서 턴이 죽으면
 * 감독이 잃는 것은 기록이 아니라 지시다.
 */
export function journal(entry: JournalEntry): void {
  if (sink === null) return;
  try {
    sink(entry);
  } catch (error) {
    console.warn(`[journal] ${entry.kind} 사실을 앉히지 못했습니다:`, error);
  }
}

/** 경고를 콘솔과 기록에 함께 남긴다 — 서버 콘솔로만 흐르던 줄이 턴에 붙는다 */
export function journalWarn(where: string, text: string, detail?: unknown): void {
  if (detail === undefined) console.warn(`[${where}] ${text}`);
  else console.warn(`[${where}] ${text}`, detail);
  journal({
    kind: "warn",
    where,
    text,
    ...(detail === undefined
      ? {}
      : { detail: detail instanceof Error ? detail.message : String(detail) }),
  });
}

/**
 * 턴 앞뒤의 **상태 요약** — 장부의 사본이 아니라 그 턴이 무엇을 움직였는지를 보는 눈금.
 *
 * 날짜·시각·국면·시즌·진행 중인 경기·우리 전술판(6축과 선발 열한 명의 자리·좌표·역할,
 * 벤치)·주요 표의 줄 수다. 앞뒤 둘을 견주면 턴이 건드린 곳이 보이고, 낱낱은 세이브가
 * 갖는다. 전술판을 통째로 싣는 이유는 자리와 좌표가 **판이 세운 것인지 감독이 옮긴
 * 것인지**가 이 기록에서만 갈리기 때문이다.
 */
export interface TurnDigest {
  date: string;
  clock: string;
  phase: string;
  season: number;
  match: { matchId: string; minute: number; score: { home: number; away: number } } | null;
  /** 열린 협상 방 — 어느 협상인가·앉았는가. 없으면 null */
  negotiation: { negotiationId: string; seated: boolean } | null;
  board: {
    spec: TacticsSpec;
    starting: Array<{
      playerId: string;
      position: string;
      point: BoardPoint | null;
      roleId: string | null;
    }>;
    bench: string[];
  } | null;
  counts: Record<string, number>;
}

export function turnDigestOf(state: GameState): TurnDigest {
  const tactics = state.tactics.find((t) => t.teamId === state.userTeamId) ?? null;
  const pending = state.pendingMatch;
  return {
    date: state.date,
    clock: clockOf(state),
    phase: state.phase,
    season: state.season,
    match: pending
      ? {
          matchId: pending.matchId,
          minute: pending.ledger.minute,
          score: { ...pending.ledger.score },
        }
      : null,
    negotiation: state.pendingNegotiation
      ? {
          negotiationId: state.pendingNegotiation.negotiationId,
          seated: state.pendingNegotiation.seated === true,
        }
      : null,
    board: tactics
      ? {
          spec: { ...tactics.spec },
          starting: tactics.assignments
            .filter((a) => a.role === "starting")
            .map((a) => ({
              playerId: a.playerId,
              position: a.position,
              point: a.point ? { ...a.point } : null,
              roleId: a.roleId ?? null,
            })),
          bench: tactics.assignments.filter((a) => a.role === "bench").map((a) => a.playerId),
        }
      : null,
    counts: {
      chat: state.chat.length,
      players: state.players.length,
      injuries: state.injuries.length,
      suspensions: state.suspensions.length,
      negotiations: state.negotiations.length,
      promises: state.promises.length,
      issues: state.issues.length,
      transferList: state.transferList.length,
      transfers: state.transfers.length,
      scoutReports: state.scoutReports.length,
      pendingEdits: state.pendingEdits?.length ?? 0,
      pendingNews: state.pendingNews?.length ?? 0,
      incidents: state.incidents?.length ?? 0,
      narrative: state.narrative.length,
    },
  };
}
