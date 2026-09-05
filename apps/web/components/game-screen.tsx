"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { GamePayload, GameSlice } from "@/lib/store";
import { mergeSlice } from "@/lib/game-slice";
import type { ChatTurn } from "@story-fm/engine";
import type { TurnOperation } from "@story-fm/agents";
import { ChatTurnView, turnStamp } from "./chat";
import { chatForActiveMatch } from "@/lib/match-chat";
import { buildTraceIndex } from "@/lib/turn-trace-index";
import { TurnTracePopup } from "./turn-trace";
import { mergeMatchOrders, type MatchBoardOrder } from "@/lib/match-orders";
import { streamTurn, type TurnStreamFailure } from "@/lib/turn-stream";
import { Composer } from "./composer";
import { RailHints, useRailHints } from "./rail-hints";
import { Loading } from "./loading";
import { SquadView, CalendarView, FinanceView, CompetitionsView, CareerView } from "./office";
import { MatchReportPanel } from "./office/match-report";
import { createLineupSaver, type LineupSaver } from "./lineup-saver";
import { MatchClock, MatchHeadline, MatchOpponent, MatchOverview } from "./match-view";
import { StageSplitHandle } from "./stage-split-handle";
import { PlayerCardProvider } from "./player-card";
import {
  IconBoard,
  IconBroadcast,
  IconCalendar,
  IconCareer,
  IconChat,
  IconChevron,
  IconFinance,
  IconMark,
  IconMatch,
  IconSquad,
  IconTrophy,
} from "./icons";

/**
 * ── 화면 구조 ─────────────────────────────────────────────
 *
 * **채팅이 곧 화면이다.** 이 게임의 핵심 상호작용은 말이고, 나머지는 그 말을
 * 뒷받침하는 장부다. 그래서 채팅은 탭 하나가 아니라 **무대(stage)**를 통째로 쓰고,
 * 경기가 시작되면 그 무대가 둘로 갈려 **판세와 중계가 나란히** 보인다 — 감독은
 * 왼쪽에서 읽고 오른쪽에 지시한다. 탭을 오가며 상황을 기억할 필요가 없다.
 *
 * 장부 뷰(스쿼드·달력·재정·대회·커리어)는 **오른쪽 위 아이콘 줄**에서 연다 —
 * 채팅과 같은 줄에 나란히 세우면 화면의 주인이 무엇인지가 흐려진다.
 */
const PANELS = [
  { key: "스쿼드", Icon: IconSquad },
  { key: "달력", Icon: IconCalendar },
  { key: "재정", Icon: IconFinance },
  { key: "대회", Icon: IconTrophy },
  { key: "커리어", Icon: IconCareer },
] as const;
type Panel = (typeof PANELS)[number]["key"];

/**
 * 장부 칸이 열리고 접히는 시간 — **CSS의 `--panel-anim`과 같은 값이어야 한다.**
 * 접히는 동안은 내용을 그려 두고(빈 칸이 접히면 화면이 툭 꺼진다) 이만큼 뒤에 지운다.
 */
const PANEL_ANIM_MS = 260;

/**
 * 턴이 끝난 뒤 서버 상태를 다시 받아 오는 시도 횟수 — 한 번은 `settled=1`의 상한
 * (30초)만큼 기다리므로 셋이면 1분 30초다. 그보다 오래 도는 턴은 감독이 다음 조작을
 * 할 때 어차피 새 상태를 받는다 (docs/llm/models.md §1-1).
 */
const RESYNC_TRIES = 3;

/**
 * 경기 중 탭 — **화면이 통째로 바뀐다.**
 *
 * 경기 90분 안에 볼 것만 남긴다: 재정·커리어는 그때 갈 곳이 아니다. 감독이
 * 정지점에서 묻는 것은 셋뿐이라 탭도 셋이다.
 *
 * | 탭 | 질문 |
 * | --- | --- |
 * | **판세** | 어디가 밀리나, 그리고 왜 (존 막대 + 키포인트) |
 * | **팀** | 누구를 빼고 무엇을 지시하나 (전술판 + 명단 — 우리/상대) |
 * | **대회** | 이 결과가 어디로 가나 (순위표 + 다음 경기) |
 */
const MATCH_PANELS = [
  { key: "판세", Icon: IconMatch },
  { key: "팀", Icon: IconBoard },
  { key: "대회", Icon: IconTrophy },
] as const;
type MatchTab = (typeof MATCH_PANELS)[number]["key"];

/**
 * 경기 구간을 한 덩어리로 묶는다 — **끝난 경기는 메인 채팅에서 접힌다.**
 *
 * 경기 하나가 중계 수십 턴을 남기는데 그게 평시 대화 사이에 그대로 흐르면,
 * 한 시즌을 보낸 뒤 "지난주에 뭘 지시했더라"를 찾을 수 없다. 경기는 그 자체로
 * 하나의 사건이므로 결과 한 줄로 접고, 펼치면 그때의 중계와 지시가 그대로 나온다.
 *
 * `matchId`가 없는 옛 이력의 경기 턴은 묶지 않고 그대로 흐른다 — 어느 경기의
 * 기록인지 모르는 채로 접으면 무엇을 펼치는지 알 수 없다.
 */
type ChatBlock =
  | { kind: "turn"; turn: ChatTurn; at: number }
  | { kind: "match"; matchId: string; turns: Array<{ turn: ChatTurn; at: number }> };

function groupMatchTurns(chat: readonly ChatTurn[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  for (const [at, turn] of chat.entries()) {
    const id = turn.inMatch === true ? turn.matchId : undefined;
    if (id === undefined) {
      blocks.push({ kind: "turn", turn, at });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.kind === "match" && last.matchId === id) last.turns.push({ turn, at });
    else blocks.push({ kind: "match", matchId: id, turns: [{ turn, at }] });
  }
  return blocks;
}

/**
 * 턴 원문을 볼 수 있는가 — **개발 모드에서만.** 기록도 라우트도 같은 기준으로
 * 닫힌다(`traceEnabled`, models.md §5). Next가 이 값을 클라이언트 번들에
 * 인라인하므로 프로덕션 빌드에서는 상수 `false`가 되어 제스처가 통째로 사라진다.
 */
const TRACE_ENABLED = process.env.NODE_ENV !== "production";

export function GameScreen({ gameId }: { gameId: string }) {
  const [game, setGame] = useState<GamePayload | null>(null);
  /**
   * 지금 화면에 선 경기 — **입장 전에는 아직 평시다.**
   *
   * `start_match`는 판을 세울 뿐이라 코어의 `phase`는 이미 경기지만, 화면은
   * 감독이 입장 확인 창을 지날 때 바뀐다. 그때까지 뒤에 남는 것은 오피스이고,
   * 감독은 마지막으로 명단을 훑거나 마음을 바꿀 수 있다.
   */
  const pendingMatch = game?.views.match ?? null;
  const liveMatch = pendingMatch?.beforeKickoff === true ? null : pendingMatch;
  /** 열린 장부 뷰 — null이면 무대(채팅 / 경기+채팅)가 보인다 */
  const [panel, setPanel] = useState<Panel | null>(null);
  /**
   * 화면에 **그려 두는** 장부 — 닫힌 뒤에도 열이 접히는 동안은 남는다.
   *
   * `panel`을 그대로 쓰면 닫는 순간 내용이 먼저 사라져 빈 칸이 접히는 꼴이 된다.
   * 접힘이 끝나고 나서 지운다.
   */
  const [shownPanel, setShownPanel] = useState<Panel | null>(null);
  useEffect(() => {
    if (panel !== null) {
      setShownPanel(panel);
      return;
    }
    const t = setTimeout(() => setShownPanel(null), PANEL_ANIM_MS);
    return () => clearTimeout(t);
  }, [panel]);
  /**
   * 전술판을 펼쳐 두었나 — **스쿼드가 채팅 옆에 설 수 있는지를 가른다.**
   *
   * 스쿼드가 통째로 반쪽에 들어오면 전술판이 200px로 눌려 아무 쓸모가 없다.
   * 감독이 채팅을 보며 곁눈질하는 것은 대개 명단이고(누가 부상인가, 폼이 어떤가),
   * 판을 만지는 것은 그 자체로 하나의 일이다. 그래서 명단이 먼저 서고, 판을
   * 펼치면 그때 화면을 통째로 쓴다. 선택은 기억한다 — 탭을 오갈 때마다 접히면
   * 판을 쓰는 감독이 매번 다시 편다.
   *
   * **경기 중 팀 탭도 같은 상태를 쓴다.** 무대의 반쪽에 판을 밀어 넣으면 명단이
   * 눌려 누구를 뺄지 읽을 수 없고, 정지점마다 급한 건 대개 체력과 평점이다.
   * 우리 팀·상대 팀이 한 상태를 나눠 갖는 이유는 둘이 같은 구성이기 때문이다 —
   * 한쪽만 접히면 탭을 옮길 때마다 화면이 다른 모양이 된다.
   */
  const [boardOpen, setBoardOpen] = useState(false);
  /**
   * 서랍이 **나가는 중인가** — 닫는 몸짓을 위한 유예다.
   *
   * 접는 순간 판을 흐름에서 빼면(`folded`) 화면에서 툭 사라져 어디로 갔는지가
   * 남지 않는다. 열 때와 같은 시간(`PANEL_ANIM_MS`)만큼 더 그려 두고, 그동안
   * 오른쪽으로 미끄러져 나간다. 장부 칸이 접히는 동안 내용을 남겨 두는 것
   * (`shownPanel`)과 같은 장치다.
   */
  const [boardClosing, setBoardClosing] = useState(false);
  const boardCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toggleBoard = useCallback(() => {
    if (boardCloseTimer.current) clearTimeout(boardCloseTimer.current);
    setBoardOpen((open) => {
      // 나가는 도중에 다시 부르면 그 자리에서 되돌아온다 — 유예를 취소한다
      if (open) {
        setBoardClosing(true);
        boardCloseTimer.current = setTimeout(() => setBoardClosing(false), PANEL_ANIM_MS);
      } else setBoardClosing(false);
      return !open;
    });
  }, []);
  useEffect(
    () => () => void (boardCloseTimer.current && clearTimeout(boardCloseTimer.current)),
    [],
  );
  /**
   * 바뀐 장부를 알리는 말풍선 — **선다 · 읽힌다 · 닫힌다 · 다시 불린다**가
   * 한 자리에 있다 (`rail-hints.tsx`). 무대는 무엇을 눌렀는지만 넘긴다.
   */
  const rail = useRailHints({ chat: game?.chat, panel });
  /**
   * 전술판에서 쌓인 조작 — 다음 턴에 함께 나간다 (대기 목록을 화면에 그리지는
   * 않는다: 판 자체가 바뀐 모습이 곧 표시다).
   */
  const ordersRef = useRef<MatchBoardOrder[]>([]);
  /**
   * 전술판의 자동 저장 대기열 — **판이 아니라 화면이 쥔다.**
   *
   * 전술을 바꾸고 곧바로 말을 걸면, 예약된 저장이 아직 서버에 닿지 않은 채 턴이
   * 나가 GM은 옛 전술로 답했다(화면엔 바꾼 판이 그대로 보이므로 코치만 딴소리를
   * 하는 것처럼 보인다). 그래서 턴을 보내기 전에 여기서 대기열을 비운다 —
   * 판이 접혀 사라져도 예약은 이 자리에 남는다.
   */
  const saverRef = useRef<LineupSaver | null>(null);
  saverRef.current ??= createLineupSaver();
  const saver = saverRef.current;
  /**
   * 라인업 저장 응답을 화면에 앉힌다 — **온 뷰만 갈아끼우고, 턴이 지나간 뒤에
   * 도착한 것은 버린다.**
   *
   * 응답은 그 라우트가 바꾼 뷰 하나만 싣는다(`GameSlice`). 나머지는 화면이 쥔 것이
   * 그대로 남으므로 판을 짜는 동안 채팅·순위·일정이 다시 그려지지 않는다.
   *
   * 저장은 턴보다 앞선 상태에서 출발하므로, 늦게 닿으면 방금 받은 턴 결과를
   * 되감는다. 턴은 대화를 늘리는 유일한 길이라 그 길이로 낡음을 가른다.
   * 버려도 잃는 것은 없다 — 그 저장의 결과는 이미 턴 응답에 들어 있다.
   */
  const applyLineupSave = useCallback((slice: GameSlice) => {
    setGame((cur) =>
      cur === null || slice.chatLength < cur.chat.length ? cur : mergeSlice(cur, slice),
    );
  }, []);
  /**
   * 방금 끝난 경기 — **종료 화면**을 세운다.
   *
   * 휘슬과 함께 평시 화면으로 툭 돌아가면 90분이 무엇으로 끝났는지 확인할 자리가
   * 없다(중계는 이미 결과 카드로 접힌다). 닫으면 오피스로 돌아간다.
   */
  const [finished, setFinished] = useState<string | null>(null);
  const wasInMatch = useRef<string | null>(null);
  /** 경기 중 오른쪽에 선 탭 — 킥오프 직후엔 판세부터 본다 */
  const [matchTab, setMatchTab] = useState<MatchTab>("판세");
  /** 선수 탭의 하위 갈래 — 우리 팀과 상대는 담는 게 같고 정확도만 다르다 */
  const [squadSide, setSquadSide] = useState<"ours" | "theirs">("ours");
  /** 자연어 포메이션 변경 뒤에는 진행하지 않고 우리 전술판을 검토 화면으로 연다. */
  useEffect(() => {
    const turn = game?.chat.at(-1);
    if (!turn || turn.role !== "model" || turn.inMatch !== true) return;
    const changedFormation = turn.toolCalls.some((call) => {
      if (call.name !== "set_player_tactic" || !call.input || typeof call.input !== "object")
        return false;
      const input = call.input as { position?: unknown; point?: unknown };
      return typeof input.position === "string" || input.point !== undefined;
    });
    if (!changedFormation) return;
    setMatchTab("팀");
    setSquadSide("ours");
    setBoardClosing(false);
    setBoardOpen(true);
  }, [game?.chat]);
  const [input, setInput] = useState("");
  /**
   * 원문 창이 열린 턴의 자리 (`game.chat`의 절대 인덱스) — 개발 모드에서만 찬다.
   * 게임의 일부가 아니라 개발 도구라 세이브에도 URL에도 남기지 않는다.
   */
  const [traceAt, setTraceAt] = useState<number | null>(null);
  /* 창의 Esc·포커스 정리가 매 렌더마다 다시 걸리지 않게 닫는 손잡이는 고정한다 */
  const closeTrace = useCallback(() => setTraceAt(null), []);
  /** 펼쳐 둔 경기 기록 — 접힌 게 기본이다 (끝난 경기는 결과만 남는다) */
  const [openLogs, setOpenLogs] = useState<ReadonlySet<string>>(new Set());
  const toggleLog = useCallback((id: string) => {
    setOpenLogs((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 실패 원인(기술적) — 배너 툴팁으로만 보인다. 채팅·서사에는 절대 넣지 않는다 */
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  /**
   * 그대로 다시 보내면 통할 실패인가 — **서버가 적어 보낸 사실이다**(`retry`,
   * models.md §1-1). 거짓이면 배너에 「다시 시도」를 세우지 않는다: 설정이 틀려
   * 몇 번을 불러도 같은 400이 오는 자리에서 그 버튼은 없는 길을 가리킨다.
   */
  const [errorRetry, setErrorRetry] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 타이핑 리빌 — 수신 버퍼(acc)를 시간 기반으로 글자 단위 공개한다.
  // rAF(부드러움) + 인터벌(백그라운드 탭 보험) 이중 틱, 진행량은 경과 시간 기준.
  const streamAccRef = useRef("");
  const revealedRef = useRef(0);
  const pendingPayloadRef = useRef<GamePayload | null>(null);
  /**
   * 보낸 턴의 일련번호 — 실패 뒤 재조회가 **그 사이 앉은 새 턴 결과를 덮지 않게** 한다.
   * 재조회는 서버 잠금이 풀리기를 기다리므로 늦게 돌아올 수 있다.
   */
  const turnSeqRef = useRef(0);
  const rafRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch(`/api/games/${gameId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setGame(data);
      })
      .catch(() => setError("게임을 불러오지 못했습니다"));
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [gameId]);

  /**
   * 대화는 늘 바닥에 붙어 있다.
   *
   * 넓은 화면에서는 **채팅이 장부 옆에 남으므로** `panel === null` 조건을 걸면
   * 그 동안 도착한 턴이 스크롤 밖에 쌓인다. 채팅이 접힌 화면에서는 높이가 0이라
   * 이 호출이 아무 일도 하지 않고, `panel`이 의존성에 있어 닫는 순간 다시 붙는다.
   */
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [game?.chat.length, busy, streamText, panel]);

  /** 경기가 끝나는 순간을 잡는다 — 판세가 사라지면 그 경기의 종료 화면을 연다 */
  useEffect(() => {
    const now = liveMatch?.matchId ?? null;
    if (wasInMatch.current !== null && now === null) setFinished(wasInMatch.current);
    /**
     * 킥오프 — 열어 두었던 장부를 닫는다. 90분 동안 오른쪽 칸의 주인은 판이고,
     * 그때 상단 줄은 경기 탭으로 바뀌어 있어 **장부를 닫을 손잡이 자체가 없다**.
     */
    if (wasInMatch.current === null && now !== null) setPanel(null);
    wasInMatch.current = now;
  }, [liveMatch?.matchId]);

  /**
   * 턴 전송 — `text`를 주면 입력창 대신 그 문장을 보낸다 (시간 이동 버튼).
   *
   * 버튼이 API를 직접 부르지 않고 **채팅으로 도는** 이유: 시간이 흐르면 그동안
   * 벌어진 일을 GM이 장면으로 열어 준다. 버튼이 엔진만 돌리면 날짜만 바뀌고
   * 세계는 아무 말도 하지 않는다 — 이 게임에서 시간 진행은 서사의 입구다.
   */
  const send = useCallback(
    async (text?: string, operation?: TurnOperation) => {
      const message = operation ? "" : (text ?? input).trim();
      if ((!message && !operation) || busy || !game) return;
      const seq = ++turnSeqRef.current;
      setBusy(true);
      setError(null);
      setErrorDetail(null);
      setErrorRetry(true);
      /**
       * 미저장 전술판 편집을 **먼저 서버에 밀어 넣는다** — 턴은 그다음이다.
       *
       * 자동 저장은 조작이 멎기를 기다리므로(`AUTOSAVE_MS`), 판을 만지고 곧바로 말을
       * 걸면 서버는 옛 배치로 GM 입력을 만든다. 저장이 반려되면(GK 자리 등) 턴을
       * 보내지 않는다 — 화면과 다른 판으로 세계가 답하느니 이유를 말하고 멈춘다.
       */
      const saved = await saver.flush();
      if (saved && !saved.ok) {
        setBusy(false);
        setError(`전술판을 저장하지 못했습니다 — ${saved.error}`);
        return;
      }
      /**
       * 전술판에서 쌓인 조작 — **이번 턴에 함께 나간다.**
       *
       * 조작할 때마다 턴을 태우면 중계 중에 판을 만질 수 없고(모델이 응답 중),
       * 한 번의 교체 판단이 여러 번의 왕복이 된다. 판은 언제든 만지되 그 변화는
       * 감독이 다음으로 말을 건네거나 경기를 진행할 때 한 묶음으로 전달된다.
       */
      // 실패 뒤 복원된 옛 대기열도 전송 직전에 다시 접는다. 같은 자리·역할을
      // 여러 번 만진 기록이 과거 배열에 남아 있어도 마지막 선택 하나만 보낸다.
      const orders = mergeMatchOrders([], ordersRef.current);
      ordersRef.current = [];
      if (!operation && text === undefined) setInput("");
      streamAccRef.current = "";
      revealedRef.current = 0;
      pendingPayloadRef.current = null;
      setStreamText("");
      /**
       * 낙관적 표시 — 유저 턴 먼저. 턴이 실패하면 이 항목을 정확히 되돌린다
       * (서버도 실패한 턴은 저장하지 않는다 — lib/turn-runner.ts).
       *
       * 조작이면 아무것도 띄우지 않는다: 감독이 친 말이 아니라 손잡이를 누른
       * 것이라, 화면에는 진행 결과만 나타나야 한다. 기다리는 동안은 `busy`가
       * 띄우는 점 세 개(`.thinking`)가 이미 말해 준다.
       */
      const activeMatchId = liveMatch?.matchId;
      const optimistic = operation
        ? null
        : {
            role: "user" as const,
            text: message,
            toolCalls: [],
            at: game.date,
            ...(activeMatchId ? { inMatch: true as const, matchId: activeMatchId } : {}),
          };
      if (optimistic) setGame((g) => (g ? { ...g, chat: [...g.chat, optimistic] } : g));

      /**
       * 턴 실패 — 낙관적 유저 턴을 지우고 배너를 세운다 (채팅엔 아무것도 남기지 않는다).
       *
       * **되돌리는 것은 서버가 그 턴을 확실히 버렸을 때뿐이다.** 화면이 기다리기를 멈춘
       * 뒤에도 서버는 턴을 끝까지 돌려 저장하므로(models.md §1-1), 그때 지시를 대기열로
       * 돌려놓으면 재시도가 같은 지시를 두 번 태우고 이미 적용된 교체 지시는 400이 된다.
       * 입력창의 말도 같은 이유로 되돌리지 않는다 — 그 말은 이미 서버에 가 있다.
       */
      const fail = (failure: TurnStreamFailure) => {
        if (failure.settled) {
          if (orders.length > 0) ordersRef.current = mergeMatchOrders(orders, ordersRef.current);
          if (!operation && text === undefined) setInput((cur) => (cur.trim() ? cur : message));
        }
        if (optimistic) {
          setGame((g) => (g ? { ...g, chat: g.chat.filter((t) => t !== optimistic) } : g));
        }
        setError(failure.reason);
        setErrorDetail(failure.detail ?? null);
        setErrorRetry(failure.retry);
      };

      /**
       * 서버가 무엇을 저장했는지 다시 받아 화면을 맞춘다.
       *
       * `settled=1`은 그 세이브의 잠금이 풀린 **다음에** 읽어 달라는 뜻이다 — 지금
       * 읽으면 아직 커밋 전이라 옛 상태가 오고, 잠시 뒤 서버가 저장하면 화면은 다시
       * 어긋난다. 기다리는 동안 감독은 막히지 않는다(다음 턴도 같은 잠금에 줄을 선다).
       */
      const resync = async () => {
        /**
         * 잠금을 기다리는 데는 상한이 있어(models.md §1-1) 아직 도는 턴은 409로
         * 돌아온다. **몇 번은 다시 묻는다** — 한 번에 그만두면 긴 턴이 커밋한 결과를
         * 화면이 영영 못 받고, 무한히 물으면 상한을 둔 뜻이 없어진다.
         */
        for (let tries = 0; tries < RESYNC_TRIES; tries++) {
          // 그 사이 새 턴이 앉았다면 이 응답은 이미 지난 상태다
          if (turnSeqRef.current !== seq) return;
          try {
            const res = await fetch(`/api/games/${gameId}?settled=1`);
            const data = (await res.json()) as GamePayload | { error: string; retry?: boolean };
            if (!("error" in data)) {
              if (turnSeqRef.current === seq) setGame(data);
              return;
            }
            if (data.retry !== true) return;
          } catch {
            // 재조회마저 닿지 않으면 화면은 그대로 둔다 — 배너가 이미 서 있다
            return;
          }
        }
      };

      let finished = false;
      const stopPump = () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = null;
      };
      const commit = (payload: GamePayload | null) => {
        if (finished) return;
        finished = true;
        stopPump();
        // 지난 알림의 "읽음"은 새 GM 턴이 들어오는 렌더에서 함께 풀린다 (`hintTurn`)
        if (payload) setGame(payload);
        setStreamText("");
        setBusy(false);
        /**
         * 답이 끝나면 **커서를 입력칸으로 돌려준다** — 감독은 대개 이어서 말한다.
         *
         * 한 틱 미루는 이유: 입력칸은 `disabled={busy}`라 이 시점의 DOM은 아직
         * 잠겨 있고, 잠긴 요소에는 포커스가 걸리지 않는다.
         *
         * 장부 뷰(스쿼드·달력…)를 열어 두었으면 입력칸 자체가 없어 `ref`가 null이다 —
         * 그때는 아무 일도 하지 않는다. 읽고 있는 화면에서 커서를 뺏지 않는다.
         */
        requestAnimationFrame(() => inputRef.current?.focus());
      };
      // 글자 공개 속도: 기본 ~60자/초, 밀린 만큼 가속. 진행량은 경과 시간
      // 기준이라 rAF·인터벌 어느 틱이 와도 총 속도는 같다.
      let lastTick = performance.now();
      const step = (): boolean => {
        if (finished) return true;
        const now = performance.now();
        const dt = Math.min(1000, now - lastTick);
        lastTick = now;
        const target = streamAccRef.current.length;
        const r = revealedRef.current;
        if (r < target) {
          const backlog = target - r;
          const cps = 60 + backlog * 2;
          const chars = Math.max(1, Math.round((cps * dt) / 1000));
          revealedRef.current = Math.min(target, r + chars);
          setStreamText(streamAccRef.current.slice(0, revealedRef.current));
          return false;
        }
        if (pendingPayloadRef.current) {
          const payload = pendingPayloadRef.current;
          pendingPayloadRef.current = null;
          commit(payload);
          return true;
        }
        return false;
      };
      const rafLoop = () => {
        if (step()) return;
        rafRef.current = requestAnimationFrame(rafLoop);
      };
      rafRef.current = requestAnimationFrame(rafLoop);
      // 백그라운드 탭에서는 rAF가 멈추므로 인터벌이 진행·커밋을 보장한다
      intervalRef.current = setInterval(step, 300);

      /**
       * 줄 하나가 이벤트 하나 — 프로토콜은 `lib/turn-stream.ts`가 안다. 여기서는
       * **글자를 버퍼에 붓고, 끝난 턴을 공개가 끝난 뒤에 앉힐 자리에 둘 뿐**이다.
       */
      const failure = await streamTurn(
        gameId,
        { ...(operation ? { operation } : { message }), orders },
        {
          onDelta: (text) => {
            streamAccRef.current += text;
          },
          onDone: (payload) => {
            pendingPayloadRef.current = payload; // 공개가 끝나면 pump가 커밋
          },
        },
      );
      if (failure) {
        fail(failure);
        // 서버가 그 턴을 마저 돌려 저장했을 수 있다 — 화면을 서버에 맞춘다
        if (!failure.settled) void resync();
      }
      if (!pendingPayloadRef.current) commit(null);
    },
    [input, busy, game, liveMatch?.matchId, gameId, saver],
  );

  /**
   * 마지막으로 화면에 선 시각 — 흘러오는 턴이 같은 시각을 다시 적지 않게 한다.
   * ⚠️ 훅이라 **이른 반환 전부보다 앞**에 서야 한다 — 하나라도 뒤에 두면 그 갈래를
   * 지난 렌더와 그러지 않은 렌더의 훅 개수가 달라져 "Rendered more hooks than
   * during the previous render"로 화면이 통째로 죽는다 (실제로 그랬다).
   */
  const lastStamp = useMemo(() => {
    const visible = chatForActiveMatch(game?.chat ?? [], liveMatch?.matchId ?? null);
    for (let i = visible.length - 1; i >= 0; i--) {
      const stamp = turnStamp(visible[i]!);
      if (stamp) return stamp;
    }
    return null;
  }, [game, liveMatch?.matchId]);
  /**
   * 턴 → 원문 기록의 자리. ⚠️ **걸러지지 않은 `game.chat`**으로 만든다 —
   * 화면이 그리는 목록은 경기 중 턴을 걸러내므로 그 자리를 쓰면 남의 턴이 열린다.
   * (이 훅도 이른 반환보다 앞이어야 한다 — 위 주석 참조)
   */
  const traceIndex = useMemo(() => buildTraceIndex(game?.chat ?? []), [game?.chat]);
  const traceOpener = (turn: ChatTurn): (() => void) | undefined => {
    if (!TRACE_ENABLED) return undefined;
    const at = traceIndex.get(turn);
    return at === undefined ? undefined : () => setTraceAt(at);
  };

  if (error && !game)
    return (
      <main className="onboarding">
        <p className="error-text">{error}</p>
      </main>
    );
  if (!game)
    return (
      <main className="loading-page">
        <Loading size={34} />
      </main>
    );

  /** 폭이 곧 가독성인 뷰 — 전술판+명단·열두 달 격자는 900px 안에 넣을 수 없다 */
  const wide = shownPanel === "스쿼드" || shownPanel === "달력";

  /**
   * 다음 경기 날짜 — 시간 이동 버튼이 목표 시점을 **그대로 적어 보내려고** 쓴다.
   * 달력 뷰가 이미 표시해 둔 값이라(`isNext`) 따로 계산하지 않는다.
   */
  const nextMatchDate = game?.views.calendar.entries.find((e) => e.isNext)?.date ?? null;
  /** 경기 중에는 시간을 경기가 민다 — 손잡이를 쥐어 주지 않는다 */
  const canSkip = game?.phase !== "match";

  /**
   * 경기 중인가 — **채팅의 주인이 바뀐다.**
   *
   * 평시의 GM과 경기의 중계는 다른 에이전트이고, 감독이 거는 말도 다르다(지시 vs
   * 교체·전술). 같은 창에서 같은 모양으로 흐르면 지금 누구에게 말하고 있는지가
   * 화면에 없다. 배너로 적지 않고 **창의 결**로 알린다.
   */
  const inMatch = liveMatch !== null;
  /** 중계 화면은 코어의 별도 `casterHistory`와 같은 경계로 현재 경기만 보여 준다. */
  const visibleChat = chatForActiveMatch(game.chat, liveMatch?.matchId ?? null);
  /**
   * 오른쪽 칸에 무엇이 서는가 — **경기 판이 우선이고 장부가 그것을 덮는다.**
   * 경기 중에 장부를 열면(달력·재정) 판 대신 장부가 선다: 그때 감독이 보려는 건
   * 그쪽이고, 판세는 상단의 경기 머리가 계속 이고 있다.
   */
  const showBoard = inMatch && panel === null;
  /** 오른쪽 칸이 열려 있는가 — 폭이 0인지 반쪽인지를 가른다 */
  const rightOpen = showBoard || panel !== null;
  /**
   * 전술판이 **채팅 자리까지 받아야 하는가** — 판이 서 있는 화면에서만 참이다.
   *
   * 반쪽에 밀어 넣은 판은 200px로 눌려 칩을 끌 자리도, 열한 개를 읽을 자리도 없다.
   * 경기 중 팀 탭이든 오피스의 스쿼드 탭이든 판을 펼치는 몸짓은 같은 것이라
   * 결과도 같아야 한다 — 다른 탭(판세·대회·달력)에서는 켜 둔 상태여도 아무 일이
   * 없어야 하므로 지금 무엇이 서 있는지를 함께 본다.
   */
  const boardOnStage = showBoard ? matchTab === "팀" : shownPanel === "스쿼드";
  /** 나가는 중에도 서랍은 그려져 있어야 한다 — 그동안 오른쪽으로 미끄러진다 */
  const boardTakesStage = (boardOpen || boardClosing) && boardOnStage;
  /**
   * ── 같은 화면은 **한 번만 적는다** ─────────────────────────
   *
   * 스쿼드도 대회도 경기 탭과 장부 양쪽에 선다. 두 자리에 각각 써 두었더니 한쪽만
   * 고칠 때마다 두 화면이 조금씩 갈라졌다 — 경기 중의 전술판이 오피스의 것과 다른
   * 물건이 되어 갔다. 무엇을 넘길지는 여기서 한 번 정하고, 아래 두 자리는 그것을
   * 놓기만 한다. 다른 것은 **돌아갈 자리**뿐이라 그것만 받는다.
   */
  const squadView = (goBack: () => void) => (
    <SquadView
      game={game}
      onUpdate={applyLineupSave}
      onGoToChat={goBack}
      /* 저장 대기열은 화면이 쥔다 — 턴은 이것이 빈 뒤에 나간다 */
      saver={saver}
      /* 나가는 중에도 판은 흐름에 남아 있어야 미끄러질 수 있다 */
      boardOpen={boardOpen || boardClosing}
      onToggleBoard={toggleBoard}
      /*
       * 경기 중 전술판 조작 — **지시로 보낸다.** 판에서 손을 뗀 순간 채팅으로
       * 돌아가 중계를 보게 한다: 지시의 결과는 거기서 나온다.
       */
      onOrder={
        inMatch
          ? (order) => {
              ordersRef.current = mergeMatchOrders(ordersRef.current, [order]);
            }
          : undefined
      }
    />
  );
  /**
   * 대회 뷰 — **경기 중인지가 맨 아래 카드를 가른다.** 평시엔 보고 있는 대회의
   * 다음 경기, 90분 안에는 팀의 다음 경기다 (overview §5 · match.md §8).
   */
  const competitionsView = (
    <CompetitionsView competitions={game.views.competitions} inMatch={inMatch} />
  );

  /**
   * 채팅 — 무대의 주인. 경기 중에는 오른쪽 절반으로 좁아질 뿐 사라지지 않는다.
   * ⚠️ **여기 안에서 컴포넌트를 정의하지 않는다.** 렌더마다 새 타입이 되어 React가
   * 그 아래를 통째로 다시 세우고, 입력창이 포커스를 잃는다. 파일 밖으로 뺀 것
   * (`Composer`)은 타입이 고정이라 그 함정이 없다 — 갈라지는 것은 **자리**지
   * 파일이 아니다.
   */
  const chatPane = (
    <section className={`chat-pane${inMatch ? " broadcasting" : ""}`}>
      <div className="chat-scroll" ref={scrollRef} data-testid="chat-scroll">
        {/* 화면 조작은 그리지 않는다 — 감독이 한 말이 아니다. 모델 이력에는
            **오퍼레이터 지시**로 남아 GM은 왜 시간이 흘렀는지 알되 그것을
            감독의 대사로 읽지 않는다 (gm.ts `buildOperatorMessage`) */}
        {(() => {
          /**
           * 앞 턴의 시각을 물려 준다 — 같으면 다시 적지 않는다.
           * 감독이 끼어들어도 시각은 이어진다(같은 장면이므로).
           * **화자 이름은 접지 않는다** — 턴마다 누가 말하는지 보여야 한다.
           */
          let prevStamp: string | null = null;
          const render = (turn: ChatTurn, i: number) => {
            if (turn.role === "operator") return null;
            // 감독의 발화를 눌러도 열리는 것은 **그 발화가 실려 나간 호출**이다 —
            // 인덱스를 아는 이 자리가 그것을 해석한다 (`buildTraceIndex`)
            if (turn.role !== "model")
              return <ChatTurnView key={i} turn={turn} onLongPress={traceOpener(turn)} />;
            const node = (
              <ChatTurnView
                key={i}
                turn={turn}
                playerNames={game.playerNames}
                speakerRoles={game.speakerRoles}
                prevStamp={prevStamp}
                /**
                 * 레일에 세울 말풍선 — **자동 알림은 그 턴에 바뀐 장부 전부,
                 * 칩을 누르면 그 지시 하나만.** 경기 중에는 장부 레일이 서지
                 * 않으므로 칩도 제자리에서 펼친다(손잡이를 주지 않는다).
                 */
                onRevealHint={inMatch ? undefined : rail.reveal}
                revealedCall={rail.revealedCall}
                onLongPress={traceOpener(turn)}
              />
            );
            prevStamp = turnStamp(turn) ?? prevStamp;
            return node;
          };
          return groupMatchTurns(visibleChat).map((block, bi) => {
            if (block.kind === "turn") return render(block.turn, block.at);
            const log = game.matchLogs[block.matchId];
            // 진행 중인 경기(결과가 아직 없다)는 접지 않는다 — 지금 보고 있는 것이다
            const done = log?.score != null;
            const open = !done || openLogs.has(block.matchId);
            return (
              <div className="match-log" key={`m${bi}`} data-testid={`match-log-${block.matchId}`}>
                {done && (
                  <button
                    className={`match-log-head${open ? " open" : ""}`}
                    onClick={() => toggleLog(block.matchId)}
                    aria-expanded={open}
                  >
                    <IconBroadcast size={14} />
                    <b>{log?.score}</b>
                    <span className="match-log-title">{log?.title}</span>
                    <span className="match-log-date">{log?.date}</span>
                    <IconChevron size={14} />
                  </button>
                )}
                {open && (
                  <div className="match-log-body">
                    {block.turns.map(({ turn, at }) => render(turn, at))}
                  </div>
                )}
              </div>
            );
          });
        })()}
        {busy && streamText && (
          <ChatTurnView
            turn={{ role: "model", text: streamText, toolCalls: [], at: game.date }}
            streaming
            playerNames={game.playerNames}
            speakerRoles={game.speakerRoles}
            /* 흘러오는 턴에도 앞 시각을 물려 준다 — 안 주면 같은 시각이 스트리밍
               중에만 섰다가 저장된 턴으로 바뀌는 순간 사라져 깜빡인다 */
            prevStamp={lastStamp}
          />
        )}
        {/* 기다리는 중 — **말로 적지 않는다.** "세계가 반응하는 중…"은 매 턴 같은
            문장이 대화 사이에 끼어 실제 대사인 척했다. 점 세 개면 충분하다 */}
        {busy && !streamText && (
          <div className="thinking" role="status" aria-label="응답을 기다리는 중">
            <i />
            <i />
            <i />
          </div>
        )}
      </div>
      {/* 턴 실패 알림 — **게임 밖의 사건**이라 대화 흐름이 아니라 별도 띠로
              보여준다. 세계의 화자는 이 일을 알지 못한다 (turn-runner.ts) */}
      {error && (
        <div className="turn-error" data-testid="turn-error" title={errorDetail ?? undefined}>
          <span>⚠️ {error}</span>
          <div className="turn-error-actions">
            {errorRetry && (
              <button onClick={() => send()} disabled={busy || !input.trim()}>
                다시 시도
              </button>
            )}
            <button
              className="ghost"
              onClick={() => {
                setError(null);
                setErrorDetail(null);
              }}
              aria-label="알림 닫기"
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {/**
       * 시계가 멎었다 — **오류가 아니라 사실이다.** 모델의 첫 줄 헤더가 연달아
       * 읽히지 않으면 세계는 오늘에 머무는데, 그건 화면 어디에도 보이지 않고
       * 서버 로그에만 쌓였다 (docs/llm/agents.md §2). 무엇을 하라고 이르지는
       * 않는다 — 시간을 넘기는 손잡이는 바로 아래에 이미 서 있다.
       */}
      {game.clockStalled !== undefined && (
        <div className="turn-notice" data-testid="clock-stalled" role="status">
          <span>
            ⏸ 시계가 {game.clockStalled}턴째 {game.date} {game.timeOfDay}에 멈춰 있습니다
          </span>
        </div>
      )}
      <Composer
        input={input}
        onInput={setInput}
        onSend={send}
        onOperate={(operation) => void send(undefined, operation)}
        busy={busy}
        inMatch={inMatch}
        canSkip={canSkip}
        nextMatchDate={nextMatchDate}
        inputRef={inputRef}
      />
    </section>
  );

  return (
    /**
     * **이름을 눌러 여는 카드는 무대 전체를 감싼다** (player.md §9.5) — 손잡이가
     * 장부 뷰 깊은 곳(재정 줄·평점표)과 채팅 산문에 함께 서기 때문이다. 사본을
     * 버리는 눈금(`stamp`)은 날짜와 대화 길이다: 시간이 흐르면 폼도 기록도 달라진다.
     */
    <PlayerCardProvider
      gameId={gameId}
      playerNames={game.playerNames}
      stamp={`${game.date}/${game.chat.length}`}
    >
      {/* `data-phase` — 화면에 단계를 적지 않는 대신 e2e가 읽는 자리. 감독에게는
          달력·채팅이 이미 말해 주므로 배지가 자리를 차지할 이유가 없었다 */}
      <div className={`app${liveMatch ? " in-match" : ""}`} data-phase={game.phase}>
        <header className="topbar">
          {/* 로고 = 게임 목록으로 나가는 문 (진행 중 턴은 서버가 마무리해 저장한다) */}
          <Link href="/" className="brand" data-testid="home-link" title="게임 목록으로">
            <IconMark />
          </Link>
          {/**
           * 내가 누구이고 지금이 언제인가 — **제목 한 줄 + 각주 한 줄.**
           *
           * 셋을 같은 크기·같은 회색으로 나란히 늘어놓았던 때는 어느 것이 무엇인지
           * 눈이 매번 세 덩어리를 다 읽어야 했다. 구단이 제목이고 감독과 시각은 그
           * 각주다 — 굵기와 색으로 층을 두면 훑을 때 하나만 읽힌다.
           *
           * 좁아지면 두 줄로 갈린다(`.topbar-sub`). 지우지는 않는다 — 셋 다 화면이
           * 바뀌어도 그대로여야 하는 좌표다. 대신 **줄임말이 붙는다**: 직함(감독)과
           * 연도, 경기 중이면 대회 이름까지. 이름과 날짜 자체는 남는다.
           */}
          <div className="topbar-meta">
            <span className="meta topbar-club" data-testid="team-name">
              {game.teamName}
            </span>
            <span className="topbar-sub">
              <span className="meta">
                {game.managerName}
                <span className="abbr"> 감독</span>
              </span>
              {/* 시즌 번호는 여기 두지 않는다 — 상단 바에서 매 순간 필요한 건 **지금이
                언제인가**뿐이고, 몇 번째 시즌인지는 커리어·대회 화면이 갖는다 */}
              {/* 경기 중에는 **경기 시계**가 이 자리를 쓴다 — 그때 필요한 시각은 그것이다 */}
              {liveMatch ? (
                <MatchClock match={liveMatch} />
              ) : (
                <span className="meta" data-testid="game-date">
                  {/* 연도는 좁아지면 접힌다 — 한 시즌 안에서 바뀌는 건 월·일이다 */}
                  <span className="abbr">{game.date.slice(0, 5)}</span>
                  {game.date.slice(5)} {game.timeOfDay}
                </span>
              )}
            </span>
          </div>
          {/*
           * 장부 뷰 — 무대의 주인은 채팅이므로 오른쪽 끝에 아이콘 줄로만 둔다.
           * **경기 중에는 서지 않는다** — 재정·커리어는 90분 안에 갈 곳이 아니고,
           * 화면이 통째로 경기의 것이 되어야 지금 무엇을 하는 중인지가 분명하다.
           */}
          {liveMatch !== null && (
            <nav className="rail match-rail" aria-label="경기 화면 이동">
              {MATCH_PANELS.map(({ key, Icon }) => (
                <button
                  key={key}
                  className={matchTab === key ? "active" : ""}
                  onClick={() => setMatchTab(key)}
                  data-testid={`mtab-${key}`}
                  title={key}
                  aria-label={key}
                >
                  <Icon />
                </button>
              ))}
            </nav>
          )}
          {liveMatch === null && (
            <nav className="rail" aria-label="화면 이동">
              <button
                className={panel === null ? "active" : ""}
                onClick={() => setPanel(null)}
                data-testid="tab-채팅"
                title="채팅"
                aria-label="채팅"
              >
                <IconChat />
              </button>
              <span className="rail-sep" />
              {PANELS.map(({ key, Icon }) => (
                <button
                  key={key}
                  className={`${panel === key ? "active" : ""}${rail.hints.some((h) => h.panel === key) ? " hinted" : ""}`}
                  onClick={() => {
                    rail.markSeen(key);
                    setPanel(panel === key ? null : key);
                  }}
                  data-testid={`tab-${key}`}
                  title={key}
                  aria-label={key}
                >
                  <Icon />
                </button>
              ))}
              {/**
               * 바뀐 장부를 알리는 말풍선 — **다음 클릭에 닫히고, 칩으로 다시 부른다.**
               *
               * 아무 표시도 없으면 지시가 먹혔는지 확인하러 탭을 열어야 한다. 그렇다고
               * 상주하면 알림이 화면의 일부가 되어 신호가 죽는다. 놓쳐도 그 지시는
               * 채팅에 칩으로 남아 있어 눌러 되부를 수 있다(`pinnedHint`).
               *
               * 아이콘 위의 점이 "여기가 바뀌었다"를 남긴다 — 말풍선을 닫아도 남는다.
               * 카드 자체의 생김새는 `RailHints`가 갖는다.
               */}
              <RailHints hints={rail.shown} pinned={rail.pinned} />
            </nav>
          )}
        </header>
        {/* 경기 머리 — 어느 탭을 보든 스코어·시계·득점자는 사라지지 않는다 */}
        {liveMatch && <MatchHeadline match={liveMatch} />}
        {/**
         * 입장 확인 — **경기의 문.**
         *
         * `start_match`는 판을 세울 뿐이고 공은 감독이 들어갈 때 구른다. 상주
         * 버튼을 두면 그날의 대화가 무슨 이야기로 흐르든 화면이 늘 같은 손잡이
         * 하나를 들이민다.
         * GM이 문을 열었을 때만 이 창이 서고, 이것이 유일한 출구다 —
         * 닫는 손잡이를 두면 되돌아간 자리에서 다시 열 방법이 없다.
         */}
        {pendingMatch?.beforeKickoff === true && (
          <div
            className="kickoff-gate"
            data-testid="kickoff-gate"
            role="dialog"
            aria-modal="true"
            aria-labelledby="kickoff-heading"
          >
            <div className="kickoff-card">
              <span className="kickoff-tag" id="kickoff-heading">
                {/* 친선은 단계가 없다 — 가운뎃점이 홀로 남지 않게 */}
                {[pendingMatch.competition, pendingMatch.stage].filter(Boolean).join(" · ")}
              </span>
              <div className="kickoff-teams">
                <b className={pendingMatch.home.ours ? "ours" : undefined}>
                  {pendingMatch.home.name}
                </b>
                <i>vs</i>
                <b className={pendingMatch.away.ours ? "ours" : undefined}>
                  {pendingMatch.away.name}
                </b>
              </div>
              <span className="kickoff-where">
                {pendingMatch.home.ours ? "홈" : "원정"} · {game.date}
              </span>
              <button
                className="primary-btn"
                autoFocus
                disabled={busy}
                /* 경기의 문도 손잡이다 — 킥오프 턴인지는 장부가 안다(`beforeKickoff`) */
                onClick={() => void send(undefined, { kind: "advance_match" })}
                data-testid="kickoff-enter"
              >
                경기장 입장
              </button>
            </div>
          </div>
        )}
        {/**
         * 종료 화면 — **휘슬과 평시 사이의 한 걸음.**
         *
         * 곧장 오피스로 돌아가면 90분이 무엇으로 끝났는지 확인할 자리가 없다
         * (중계는 이미 결과 카드로 접혀 있다). 달력 상세와 **같은 리포트 한 벌**을
         * 세운다 — 둘이 각자 접으면 같은 경기가 두 가지로 보인다 (match.md §8).
         */}
        {finished !== null && game.matchLogs[finished] && (
          <div
            className="fulltime"
            data-testid="fulltime"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fulltime-heading"
          >
            <div className="fulltime-card">
              <header className="fulltime-header">
                <span className="fulltime-tag" id="fulltime-heading">
                  경기 종료
                </span>
              </header>
              <MatchReportPanel gameId={gameId} matchId={finished} />
              <button
                className="primary-btn"
                onClick={() => setFinished(null)}
                data-testid="fulltime-close"
              >
                확인
              </button>
            </div>
          </div>
        )}

        <main className="stage">
          {/**
           * ── 무대는 **하나의 갈림**이다 ──────────────────────────
           *
           * 왼쪽은 언제나 채팅, 오른쪽은 그때 필요한 것(경기 판 / 장부)이고, 닫혀
           * 있을 땐 폭이 0이다. 경기 무대와 장부 무대의 마크업이 갈리면 킥오프·탭
           * 조작마다 채팅이 통째로 다시 그려지며 **툭** 튀고, 격자 트랙이 없다
           * 생겼다 하면 폭을 이어서 애니메이션할 수도 없다.
           *
           * 오른쪽에 무엇이 들었는지는 `with-board`/`with-ledger`가 CSS에 알린다:
           * 경기 판은 좁은 화면에서도 채팅 **옆에 서고**, 장부만 채팅을 **덮는다**.
           */}
          <div
            className={`stage-split panel-split${rightOpen ? " open" : ""}${
              showBoard ? " with-board" : " with-ledger"
            }${boardTakesStage ? " board-open" : ""}${boardClosing ? " board-closing" : ""}`}
          >
            {chatPane}
            {/* 가라앉은 대화를 덮는 판 — 누르면 서랍이 닫힌다. 서랍이 설 수 없는
              폭에서는 CSS가 걷어 낸다(`--drawer`) — 채팅을 가로막을 뿐이므로 */}
            {boardTakesStage && !boardClosing && (
              <button
                className="board-scrim"
                onClick={toggleBoard}
                aria-label="전술판 닫기"
                data-testid="board-scrim"
              />
            )}
            <section
              className="stage-right"
              aria-hidden={!rightOpen}
              /* 접힌 칸은 화면에도 손에도 없다 — 폭 0짜리 표에 탭 포커스가 빠지지 않게 */
              inert={!rightOpen}
            >
              {showBoard && liveMatch ? (
                <div className="stage-board" data-testid="stage-board">
                  {/* 탭이 바뀌면 이 덩어리가 새로 서며 흐려졌다 든다 — 판세와 명단은
                    생김새가 아주 달라서 즉시 갈리면 무엇이 바뀐 건지 읽히지 않는다 */}
                  <div className="board-tab ledger-body" key={matchTab}>
                    {matchTab === "판세" && <MatchOverview match={liveMatch} />}
                    {matchTab === "팀" && (
                      <>
                        {/**
                         * **구성은 같고 정확도만 다르다** — 양쪽 다 판 → 전술 → 명단
                         * 순으로 읽힌다. 배치를 맞춰 둬야 감독이 오갈 때 눈이 매번
                         * 자리를 다시 찾지 않는다. 상대 쪽은 안개를 지나고 조작이 없다.
                         */}
                        <div className="side-tabs" role="tablist">
                          {(["ours", "theirs"] as const).map((s2) => (
                            <button
                              key={s2}
                              role="tab"
                              aria-selected={squadSide === s2}
                              className={`side-tab${squadSide === s2 ? " on" : ""}`}
                              onClick={() => setSquadSide(s2)}
                              data-testid={`side-${s2}`}
                            >
                              {s2 === "ours" ? "우리 팀" : "상대 팀"}
                            </button>
                          ))}
                        </div>
                        {squadSide === "ours" ? (
                          /*
                           * 경기 중에도 **명단이 먼저**다 — 오피스의 스쿼드 탭과 같은
                           * 손잡이를 쓴다. 무대의 반쪽에 판을 밀어 넣으면 명단 표가
                           * 눌려 누구를 뺄지 읽을 수가 없고, 정지점마다 급한 건 대개
                           * 체력과 평점이다. 판은 필요할 때 펼친다.
                           */
                          squadView(() => setMatchTab("판세"))
                        ) : (
                          <MatchOpponent
                            match={liveMatch}
                            boardOpen={boardOpen || boardClosing}
                            onToggleBoard={toggleBoard}
                          />
                        )}
                      </>
                    )}
                    {matchTab === "대회" && competitionsView}
                  </div>
                </div>
              ) : (
                /**
                 * 장부 뷰 — **채팅을 대신하지 않고 나눠 쓴다.**
                 *
                 * 패널이 무대를 통째로 덮으면 명단을 확인하려고 연 순간 대화가
                 * 사라지고, 감독은 "방금 코치가 뭐라고 했더라"를 확인하러 다시
                 * 채팅을 열어야 한다. 폭만 있으면 둘 다 서 있는 게 맞다.
                 */
                <div
                  className={wide ? "panel wide" : "panel"}
                  data-testid={panel !== null ? `panel-${panel}` : undefined}
                >
                  {/* 폭은 뷰가 정한다 — 전술판+명단(스쿼드)과 열두 달 격자(달력)는
                    본문 900px 안에 넣으면 읽을 수가 없다.
                    `key`로 장부마다 새로 세운다 — 탭을 옮길 때 흐려졌다 든다 */}
                  <div
                    key={shownPanel ?? "none"}
                    className={`view-scroll ledger-body${wide ? " wide" : ""}${shownPanel === "스쿼드" ? " fill" : ""}`}
                  >
                    {shownPanel === "스쿼드" && squadView(() => setPanel(null))}
                    {shownPanel === "달력" && (
                      <CalendarView calendar={game.views.calendar} gameId={gameId} />
                    )}
                    {shownPanel === "재정" && <FinanceView finance={game.views.finance} />}
                    {shownPanel === "대회" && competitionsView}
                    {shownPanel === "커리어" && (
                      <CareerView squad={game.views.squad} career={game.views.career} />
                    )}
                  </div>
                </div>
              )}
            </section>
            {/* 두 칸의 경계 — 끄는 대로 무대의 `--split`이 바뀌고 거기 붙은 것들
              (덮개·전술판 서랍)이 함께 따라온다. 나란히 설 수 없는 폭에서는 CSS가
              걷어 낸다(`--split-live`) — 오른쪽 칸 **뒤에** 서야 그 위에 얹힌다 */}
            <StageSplitHandle />
          </div>
        </main>
        {/* 턴 원문 — 개발 모드에서 턴을 길게 눌렀을 때만 선다 (models.md §5) */}
        {TRACE_ENABLED && traceAt !== null && (
          <TurnTracePopup gameId={gameId} index={traceAt} onClose={closeTrace} />
        )}
      </div>
    </PlayerCardProvider>
  );
}
