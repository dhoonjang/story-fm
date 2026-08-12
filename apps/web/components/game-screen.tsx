"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { GamePayload } from "@/lib/store";
import type { ChatTurn, ToolCallRecord } from "@story-fm/engine";
import { ChatTurnView, turnStamp } from "./chat";
import { hintsOfCall, panelHintsOf, type PanelHint } from "@/lib/panel-hints";
import { chatForActiveMatch } from "@/lib/match-chat";
import { mergeMatchOrders, type MatchBoardOrder } from "@/lib/match-orders";
import { RailHints } from "./rail-hints";
import { SquadView, CalendarView, FinanceView, CompetitionsView, CareerView } from "./office";
import { MatchClock, MatchHeadline, MatchOpponent, MatchOverview } from "./match-view";
import {
  IconBoard,
  IconBroadcast,
  IconCalendar,
  IconCareer,
  IconChat,
  IconChevron,
  IconFinance,
  IconDay,
  IconMark,
  IconMatch,
  IconPlay,
  IconSend,
  IconSkip,
  IconSquad,
  IconWeek,
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
 * 장부 뷰(스쿼드·달력·재정·대회·커리어)는 **오른쪽 위 아이콘 줄**에서 연다.
 * 예전에는 채팅과 같은 줄에 나란히 서 있어서, 화면의 주인이 무엇인지가 흐렸다.
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
 * 경기 중 탭 — **화면이 통째로 바뀐다.**
 *
 * 경기 90분 안에 볼 것만 남긴다: 재정·커리어는 그때 갈 곳이 아니다. 감독이
 * 정지점에서 묻는 것은 사실 셋뿐이라 탭도 셋이다.
 *
 * | 탭 | 질문 |
 * | --- | --- |
 * | **판세** | 어디가 밀리나, 그리고 왜 (존 막대 + 키포인트) |
 * | **팀** | 누구를 빼고 무엇을 지시하나 (전술판 + 명단 — 우리/상대) |
 * | **대회** | 이 결과가 어디로 가나 (순위표 + 다음 경기) |
 *
 * 예전엔 여섯이었다. 판세와 키포인트가 갈려 있어 밀리는 걸 보고 이유를 찾으러
 * 옆 탭으로 건너가야 했고, 전술판과 선수가 갈려 있어 "누구를 뺄까"와 "누구를
 * 넣을까"가 다른 화면에 있었다. 달력은 90분 안에 볼 것이 아니다 — 그때 궁금한
 * 일정은 **다음 경기 하나**뿐이라 대회 탭 아래로 옮겼다.
 */
/**
 * 장부 칸이 열리고 접히는 시간 — **CSS의 `--panel-anim`과 같은 값이어야 한다.**
 * 접히는 동안은 내용을 그려 두고(빈 칸이 접히면 화면이 툭 꺼진다) 이만큼 뒤에 지운다.
 */
const PANEL_ANIM_MS = 260;

const MATCH_PANELS = [
  { key: "판세", Icon: IconMatch },
  { key: "팀", Icon: IconBoard },
  { key: "대회", Icon: IconTrophy },
] as const;
type MatchTab = (typeof MATCH_PANELS)[number]["key"];

/**
 * 시간을 넘기는 손잡이 — **버튼이 곧 감독의 말**이다.
 *
 * 엔진을 직접 부르지 않고 채팅으로 도는 이유는 `send`에 적어 두었다. 문장은
 * **감독의 말투가 아니라 조작의 이름**이다 — 이건 `operator` 채널로 가고
 * 모델에는 `@: [시간 진행 — 하루]`로 들어간다. "하루만 넘기자" 같은 구어체로
 * 두면 이력에 감독이 한 말처럼 남는다.
 *
 * 눈금을 셋으로 끊은 건 프리시즌 때문이다 — 7월엔 다음 경기가 몇 주 뒤라
 * "다음 경기로"만 있으면 이적·훈련을 들여다볼 틈 없이 개막까지 날아간다.
 */
/** 시간 손잡이의 얼굴 — 해(하루) · 달력 한 줄(일주일) · 공(다음 경기) */
const SKIP_ICONS = { day: IconDay, week: IconWeek, match: IconMatch } as const;

/**
 * ⚠️ 아래 `say` 문장은 **서버가 되읽는다** (`parseTimeSkip` — gm-types.ts).
 * 손잡이로 넘긴 시간만은 모델을 거치지 않고 코어가 먼저 굴리기 때문이다.
 * 문구를 바꾸면 그 파서도 함께 고쳐야 한다 — 안 그러면 조작이 감독의 발화로
 * 읽혀 시계가 모델의 헤더에 다시 매달린다 (agents 테스트가 문장을 고정한다).
 */

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

const TIME_SKIPS = [
  { key: "day", label: "하루", say: () => "시간 진행 — 하루" },
  { key: "week", label: "일주일", say: () => "시간 진행 — 일주일" },
  {
    key: "match",
    label: "다음 경기",
    /**
     * **날짜를 붙여 보낸다.** 시간은 GM이 첫 줄 헤더에 적은 시점으로 흐르므로
     * (`applyScenePoint`), 목표가 "다음 경기"라는 말뿐이면 모델이 일정을 조회해
     * 날짜를 옮겨 적어야 한다 — 한 번 더 왕복하고 틀릴 여지도 생긴다.
     * 클라이언트는 그 날짜를 이미 알고 있다(달력 뷰의 `isNext`).
     */
    say: (date: string) => `시간 진행 — 다음 경기 (${date})`,
  },
] as const;

export function GameScreen({ gameId }: { gameId: string }) {
  const [game, setGame] = useState<GamePayload | null>(null);
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
  /** 읽은 장부 알림 — 그 화면을 연 순간부터 다시 세우지 않는다 (다음 턴에 풀린다) */
  const [seenHints, setSeenHints] = useState<string[]>([]);
  /**
   * 알림을 닫았나 — **다음 클릭 한 번**이면 닫힌다.
   *
   * 알림은 지나가는 것이지 화면에 상주하는 것이 아니다. 놓쳐도 그 지시는 채팅에
   * 칩으로 남아 있어서 눌러 다시 부를 수 있다(`pinnedHint`).
   */
  const [hintsClosed, setHintsClosed] = useState(false);
  /** 채팅 칩이 다시 불러낸 말풍선 — 자동 알림과 같은 자리에 선다 */
  const [pinnedHint, setPinnedHint] = useState<{
    call: ToolCallRecord;
    hints: PanelHint[];
  } | null>(null);
  /** 칩을 눌렀다 — 같은 칩을 다시 누르면 닫는다 (칩이 곧 손잡이다) */
  const revealHint = useCallback((call: ToolCallRecord) => {
    setHintsClosed(true);
    setPinnedHint((prev) => (prev?.call === call ? null : { call, hints: hintsOfCall(call) }));
  }, []);
  /**
   * 전술판에서 쌓인 조작 — 다음 턴에 함께 나간다 (대기 목록을 화면에 그리지는
   * 않는다: 판 자체가 바뀐 모습이 곧 표시다).
   */
  const ordersRef = useRef<MatchBoardOrder[]>([]);
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
  /**
   * 마지막 턴이 바꾼 장부 — 아이콘 줄에 말풍선으로 선다.
   * 이미 연 화면은 빼고(`seenHints`), 지금 보고 있는 화면도 뺀다.
   */
  const hints = useMemo(
    () =>
      game
        ? panelHintsOf(game.chat).filter((h) => h.panel !== panel && !seenHints.includes(h.panel))
        : [],
    [game, panel, seenHints],
  );
  /**
   * **GM이 말한 횟수** — 알림이 새로 서는 기준이다.
   *
   * 채팅 길이로 재면 안 된다: 감독이 보내는 순간 낙관적 유저 턴이 먼저 들어가고
   * (`send`), 턴이 실패하면 도로 빠진다. 그때마다 리셋이 돌면 **닫아 둔 직전
   * 알림이 되살아났다가** 답이 오면 다시 바뀐다 — 그게 말풍선이 깜빡이는 이유다.
   * 알림은 세계가 무언가 한 뒤에만 새로 선다.
   */
  const modelTurns = useMemo(
    () => game?.chat.reduce((n, t) => n + (t.role === "model" ? 1 : 0), 0) ?? 0,
    [game],
  );
  /**
   * 새 턴이 오면 알림은 처음부터 — 방금 벌어진 일은 다시 알려야 한다.
   * 이전 턴에 읽은 표식(`seenHints`)도 여기서 풀린다: 그건 그 알림을 읽었다는
   * 뜻이었고, 새 지시는 새 알림이다.
   *
   * 이걸 `useEffect`로 미루면 리셋 전 한 프레임이 그려진다 — 지난 턴에 읽은
   * 알림이 잠깐 사라졌다 다시 뜬다. 렌더 중에 맞추면 그 프레임이 없다.
   */
  const [hintTurn, setHintTurn] = useState(0);
  if (hintTurn !== modelTurns) {
    setHintTurn(modelTurns);
    setHintsClosed(false);
    setPinnedHint(null);
    setSeenHints([]);
  }
  /**
   * **다른 쪽을 누르면 닫힌다.** 말풍선은 조작 대상이 아니라 지나가는 알림이라
   * 닫는 ✕를 달지 않는다 — 감독이 다음 무엇을 누르든 그게 곧 "읽었다"다.
   * 칩(`data-hint-keep`)만 예외다: 그 클릭은 말풍선을 부르는 손잡이다.
   */
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("[data-hint-keep]")) return;
      setPinnedHint((p) => (p === null ? p : null));
      setHintsClosed((c) => (c ? c : true));
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);
  const [input, setInput] = useState("");
  /** 시간 손잡이의 선택지가 펼쳐져 있는가 — 입력이 비었을 때만 열 수 있다 */
  const [skipOpen, setSkipOpen] = useState(false);
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 입력 textarea 높이 자동 조절 — 내용이 늘면 최대 높이까지 커지고 이후 스크롤
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // 타이핑 리빌 — 수신 버퍼(acc)를 시간 기반으로 글자 단위 공개한다.
  // rAF(부드러움) + 인터벌(백그라운드 탭 보험) 이중 틱, 진행량은 경과 시간 기준.
  const streamAccRef = useRef("");
  const revealedRef = useRef(0);
  const pendingPayloadRef = useRef<GamePayload | null>(null);
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
   * 예전엔 `panel === null`일 때만 굴렸다 — 장부를 열면 채팅이 화면에서 사라졌기
   * 때문이다. 이제는 넓은 화면에서 **채팅이 장부 옆에 남으므로** 조건을 걸면 그
   * 동안 도착한 턴이 스크롤 밖에 쌓인다. 채팅이 접힌 화면에서는 높이가 0이라
   * 이 호출이 아무 일도 하지 않고, `panel`이 의존성에 있어 닫는 순간 다시 붙는다.
   */
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [game?.chat.length, busy, streamText, panel]);

  /** 경기가 끝나는 순간을 잡는다 — 판세가 사라지면 그 경기의 종료 화면을 연다 */
  useEffect(() => {
    const now = game?.views.match?.matchId ?? null;
    if (wasInMatch.current !== null && now === null) setFinished(wasInMatch.current);
    /**
     * 킥오프 — 열어 두었던 장부를 닫는다. 90분 동안 오른쪽 칸의 주인은 판이고,
     * 그때 상단 줄은 경기 탭으로 바뀌어 있어 **장부를 닫을 손잡이 자체가 없다**.
     */
    if (wasInMatch.current === null && now !== null) setPanel(null);
    wasInMatch.current = now;
  }, [game?.views.match?.matchId]);

  /**
   * 턴 전송 — `text`를 주면 입력창 대신 그 문장을 보낸다 (시간 이동 버튼).
   *
   * 버튼이 API를 직접 부르지 않고 **채팅으로 도는** 이유: 시간이 흐르면 그동안
   * 벌어진 일을 GM이 장면으로 열어 준다. 버튼이 엔진만 돌리면 날짜만 바뀌고
   * 세계는 아무 말도 하지 않는다 — 이 게임에서 시간 진행은 서사의 입구다.
   */
  const send = useCallback(
    async (text?: string, operator = false) => {
      const message = (text ?? input).trim();
      if (!message || busy || !game) return;
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
      if (text === undefined) setInput("");
      setBusy(true);
      setError(null);
      setErrorDetail(null);
      streamAccRef.current = "";
      revealedRef.current = 0;
      pendingPayloadRef.current = null;
      setStreamText("");
      /**
       * 낙관적 표시 — 유저 턴 먼저. 턴이 실패하면 이 항목을 정확히 되돌린다
       * (서버도 실패한 턴은 저장하지 않는다 — lib/turn-runner.ts).
       *
       * `operator`면 아무것도 띄우지 않는다: 감독이 친 말이 아니라 손잡이를 누른
       * 것이라, 화면에는 진행 결과만 나타나야 한다. 기다리는 동안은 `busy`가
       * 띄우는 점 세 개(`.thinking`)가 이미 말해 준다.
       */
      const activeMatchId = game.views.match?.matchId;
      const optimistic = operator
        ? null
        : {
            role: "user" as const,
            text: message,
            toolCalls: [],
            at: game.date,
            ...(activeMatchId ? { inMatch: true as const, matchId: activeMatchId } : {}),
          };
      if (optimistic) setGame((g) => (g ? { ...g, chat: [...g.chat, optimistic] } : g));

      /** 턴 실패 — 낙관적 유저 턴을 지우고 입력을 되돌린다 (채팅엔 아무것도 남기지 않는다) */
      const fail = (reason: string, detail?: string) => {
        // 실패한 턴은 없었던 일이 된다 — 지시도 대기함으로 돌려놓는다
        if (orders.length > 0) ordersRef.current = mergeMatchOrders(orders, ordersRef.current);
        if (optimistic) {
          setGame((g) => (g ? { ...g, chat: g.chat.filter((t) => t !== optimistic) } : g));
        }
        if (text === undefined) setInput((cur) => (cur.trim() ? cur : message));
        setError(reason);
        setErrorDetail(detail ?? null);
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

      try {
        const res = await fetch(`/api/games/${gameId}/turn/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, operator, ...(orders.length > 0 ? { orders } : {}) }),
        });
        if (!res.ok || !res.body) {
          const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
          fail(data.error ?? "턴을 처리하지 못했습니다", data.detail);
          commit(null);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (!line.trim()) continue;
            let evt: {
              type: string;
              text?: string;
              payload?: GamePayload;
              error?: string;
              detail?: string;
            };
            try {
              evt = JSON.parse(line);
            } catch {
              continue; // 불완전한 조각은 건너뛴다 — 다음 줄에서 회복
            }
            if (evt.type === "delta" && evt.text) {
              streamAccRef.current += evt.text;
            } else if (evt.type === "done" && evt.payload) {
              pendingPayloadRef.current = evt.payload; // 공개가 끝나면 pump가 커밋
            } else if (evt.type === "error") {
              fail(evt.error ?? "턴을 처리하지 못했습니다", evt.detail);
            }
          }
        }
        // 스트림 종료 — done이 없었다면(에러 등) 즉시 마감
        if (!pendingPayloadRef.current) commit(null);
      } catch (e) {
        fail(
          "서버에 연결하지 못했습니다 — 다시 시도해 주세요.",
          e instanceof Error ? e.message : String(e),
        );
        commit(null);
      }
    },
    [input, busy, game, gameId],
  );

  if (error && !game)
    return (
      <main className="onboarding">
        <p className="error-text">{error}</p>
      </main>
    );
  /**
   * 마지막으로 화면에 선 시각 — 흘러오는 턴이 같은 시각을 다시 적지 않게 한다.
   * ⚠️ 훅이라 **`if (!game)` 앞**에 있어야 한다 — 뒤에 두면 게임이 로드되기 전과
   * 후의 훅 개수가 달라져 "Rendered more hooks than during the previous render"로
   * 화면이 통째로 죽는다 (실제로 그랬다).
   */
  const lastStamp = useMemo(() => {
    const visible = chatForActiveMatch(game?.chat ?? [], game?.views.match?.matchId ?? null);
    for (let i = visible.length - 1; i >= 0; i--) {
      const stamp = turnStamp(visible[i]!);
      if (stamp) return stamp;
    }
    return null;
  }, [game]);

  if (!game)
    return (
      <main className="onboarding">
        <p>불러오는 중...</p>
      </main>
    );

  const placeholder =
    game.phase === "match"
      ? '"계속" 으로 경기를 진행하거나, 교체·팀토크를 지시하세요'
      : game.phase === "matchday"
        ? '"경기 시작"으로 킥오프하거나, 라인업·전술을 손보세요'
        : "훈련 지시, 전술 변경, 면담… 감독으로서 말하세요";

  /** 폭이 곧 가독성인 뷰 — 전술판+명단·열두 달 격자는 900px 안에 넣을 수 없다 */
  const wide = shownPanel === "스쿼드" || shownPanel === "달력";

  /**
   * 다음 경기 날짜 — 시간 이동 버튼이 목표 시점을 **그대로 적어 보내려고** 쓴다.
   * 달력 뷰가 이미 표시해 둔 값이라(`isNext`) 따로 계산하지 않는다.
   */
  const nextMatchDate = game?.views.calendar.entries.find((e) => e.isNext)?.date ?? null;
  /** 쓸 말이 있으면 보내기, 없으면 시간 손잡이 — 버튼 하나가 두 뜻을 갖는다 */
  const hasInput = input.trim().length > 0;
  /** 경기 중에는 시간을 경기가 민다 — 손잡이를 쥐어 주지 않는다 */
  const canSkip = game?.phase !== "match";

  /**
   * 채팅 — 무대의 주인. 경기 중에는 오른쪽 절반으로 좁아질 뿐 사라지지 않는다.
   * (컴포넌트로 쪼개면 매 렌더마다 새 타입이 되어 입력창이 포커스를 잃는다)
   */
  /**
   * 경기 중인가 — **채팅의 주인이 바뀐다.**
   *
   * 평시의 GM과 경기의 중계는 다른 에이전트이고, 감독이 거는 말도 다르다(지시 vs
   * 교체·전술). 같은 창에서 같은 모양으로 흐르면 지금 누구에게 말하고 있는지가
   * 화면에 없다. 배너로 적지 않고 **창의 결**로 알린다.
   */
  const inMatch = game.views.match !== null;
  /** 중계 화면은 코어의 별도 `casterHistory`와 같은 경계로 현재 경기만 보여 준다. */
  const visibleChat = chatForActiveMatch(game.chat, game.views.match?.matchId ?? null);
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
   * 레일에 세울 말풍선 — **처음엔 그 턴에 바뀐 장부 전부, 칩을 누르면 그 하나만.**
   *
   * 자동 알림은 "방금 무엇이 달라졌나"를 한 번에 알리는 것이라 탭별로 묶어 한 장에
   * 쌓는다(시간이 흘러 다음 장으로 넘어가지 않는다 — 감독이 눈을 뗀 사이에 지나간다).
   * 칩은 그 지시 하나를 가리키므로 그 장부만 선다(`hintsOfCall`).
   * 경기 중에는 장부 레일이 서지 않으므로 칩도 제자리에서 펼친다(`onRevealHint` 없음).
   */
  const shownHints = pinnedHint ? pinnedHint.hints : hintsClosed ? [] : hints;

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
      onUpdate={setGame}
      onGoToChat={goBack}
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
  const competitionsView = (
    <CompetitionsView competitions={game.views.competitions} teamName={game.teamName} />
  );

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
            if (turn.role !== "model") return <ChatTurnView key={i} turn={turn} />;
            const node = (
              <ChatTurnView
                key={i}
                turn={turn}
                playerNames={game.playerNames}
                speakerRoles={game.speakerRoles}
                prevStamp={prevStamp}
                onRevealHint={inMatch ? undefined : revealHint}
                revealedCall={pinnedHint?.call ?? null}
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
            <button onClick={() => send()} disabled={busy || !input.trim()}>
              다시 시도
            </button>
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
       * 경기일 — **킥오프는 버튼이다.**
       *
       * 감독이 "경기 시작"이라고 타이핑해야 했다. 오늘 할 일이 그것 하나뿐인
       * 날인데 그걸 문장으로 적게 두면, 화면은 감독이 무엇을 해야 하는지 알면서도
       * 말해 주지 않는 셈이다. 오퍼레이터 조작이라 채팅에 감독 발화로 남지 않는다.
       */}
      {game.phase === "matchday" && !busy && (
        <div className="kickoff-row">
          <button
            className="kickoff"
            onClick={() => void send("경기 시작", true)}
            data-testid="kickoff"
          >
            <IconPlay size={16} />
            경기 시작
          </button>
        </div>
      )}
      {/**
       * 시간 이동 — **자주 하는 지시라 손이 아니라 눈에 둔다.**
       *
       * 매번 "다음 경기로 가자"를 타이핑하게 두면 GM이 대신 "시간을 보내시겠습니까?"
       * 하고 되묻는 장면으로 턴을 닫는다. 그건 감독이 결정할 일을 세계가 대신
       * 물어보는 것이라, 넘기는 손잡이를 감독 쪽에 두고 GM에겐 되묻지 못하게 했다.
       *
       * 다만 **늘 펼쳐 두지는 않는다.** 칩 세 개가 입력창 위에 상주하면 감독이
       * 할 일이 "말하기"인지 "넘기기"인지 화면이 두 갈래로 말한다. 입력이 비어
       * 있을 때만 같은 버튼이 시간 손잡이가 되고, 한 글자라도 쓰면 보내기가 된다 —
       * **손잡이는 하나고 뜻은 상황이 정한다.**
       *
       * 경기 중에는 숨긴다 — 그때 시간은 경기가 밀고, 진행은 채팅이 맡는다.
       */}
      <div className="composer">
        {skipOpen && canSkip && (
          <>
            {/* 바깥을 눌러 닫는다 — 메뉴 밖 어디든 */}
            <button
              className="skip-scrim"
              type="button"
              aria-label="닫기"
              onClick={() => setSkipOpen(false)}
            />
            <div className="skip-menu" data-testid="time-skip" role="menu">
              {TIME_SKIPS.map((t) => {
                // 남은 경기가 없으면(시즌 끝) 갈 곳이 없다 — 그리지 않는다
                if (t.key === "match" && !nextMatchDate) return null;
                const say = t.say(nextMatchDate ?? "");
                const Icon = SKIP_ICONS[t.key];
                return (
                  <button
                    key={t.key}
                    role="menuitem"
                    onClick={() => {
                      setSkipOpen(false);
                      send(say, true);
                    }}
                    disabled={busy}
                    data-testid={`skip-${t.key}`}
                  >
                    <Icon />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </>
        )}
        <div className="chat-input">
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              // 쓰기 시작하면 버튼이 보내기로 바뀐다 — 열려 있던 선택지는 닫는다
              if (e.target.value.trim()) setSkipOpen(false);
            }}
            onKeyDown={(e) => {
              // Enter = 전송, Shift+Enter = 줄바꿈 (IME 조합 중에는 무시)
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={placeholder}
            disabled={busy}
            data-testid="chat-input"
          />
          {/**
           * **손잡이는 하나다.** 쓸 말이 없으면 시간 손잡이, 한 글자라도 쓰면 보내기.
           *
           * 경기 중에는 시간 손잡이 자리가 **진행**이 된다 — 그때 시간을 미는 건
           * 달력이 아니라 경기이고, 감독이 할 일도 "계속"이라고 타이핑하는 게
           * 아니라 한 구간 더 굴리는 것이다.
           *
           * 아이콘만 두는 건 입력칸 **안에** 앉기 때문이다 — 글자를 얹으면 쓸 폭을
           * 뺏는다. 뜻은 `aria-label`과 툴팁이 갖는다.
           */}
          <button
            className={hasInput ? "send" : inMatch ? "send" : "skip"}
            onClick={() => {
              if (hasInput) return void send();
              if (inMatch) return void send("계속", true);
              setSkipOpen((v) => !v);
            }}
            disabled={busy || (!hasInput && !inMatch && !canSkip)}
            data-testid={hasInput ? "chat-send" : inMatch ? "match-advance" : "time-skip-toggle"}
            aria-label={hasInput ? "전송" : inMatch ? "경기 진행" : "시간 보내기"}
            aria-expanded={hasInput || inMatch ? undefined : skipOpen}
            title={hasInput ? "전송 (Enter)" : inMatch ? "경기 진행" : "시간 보내기"}
          >
            {hasInput ? <IconSend /> : inMatch ? <IconPlay /> : <IconSkip />}
          </button>
        </div>
      </div>
    </section>
  );

  return (
    /* `data-phase` — 화면에 단계를 적지 않는 대신 e2e가 읽는 자리. 감독에게는
       달력·채팅이 이미 말해 주므로 배지가 자리를 차지할 이유가 없었다 */
    <div className={`app${game.views.match ? " in-match" : ""}`} data-phase={game.phase}>
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
            {game.views.match ? (
              <MatchClock match={game.views.match} />
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
        {game.views.match !== null && (
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
        {game.views.match === null && (
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
                className={`${panel === key ? "active" : ""}${hints.some((h) => h.panel === key) ? " hinted" : ""}`}
                onClick={() => {
                  setSeenHints((seen) => (seen.includes(key) ? seen : [...seen, key]));
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
            <RailHints hints={shownHints} pinned={pinnedHint !== null} />
          </nav>
        )}
      </header>
      {/* 경기 머리 — 어느 탭을 보든 스코어·시계·득점자는 사라지지 않는다 */}
      {game.views.match && <MatchHeadline match={game.views.match} />}
      {/**
       * 종료 화면 — **휘슬과 평시 사이의 한 걸음.**
       *
       * 곧장 오피스로 돌아가면 90분이 무엇으로 끝났는지 확인할 자리가 없다
       * (중계는 이미 결과 카드로 접혀 있다). 스코어·득점·잘한 선수·다음 일정까지만
       * 짧게 보여주고 닫는다 — 자세한 건 대회·달력이 갖는다.
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
              <b className="fulltime-score">{game.matchLogs[finished].score}</b>
              <span className="fulltime-title">{game.matchLogs[finished].title}</span>
            </header>
            {game.matchLogs[finished].goals.length > 0 && (
              <section className="fulltime-section">
                <h3>득점 기록</h3>
                <div className="fulltime-goals">
                  {game.matchLogs[finished].goals.map((g, i) => (
                    <span key={i}>{g}</span>
                  ))}
                </div>
              </section>
            )}
            {game.matchLogs[finished].best.length > 0 && (
              <section className="fulltime-section">
                <h3>평점 상위</h3>
                <div className="fulltime-best">
                  {game.matchLogs[finished].best.map((b) => (
                    <span key={b.name}>
                      {b.name} <b>{b.rating.toFixed(1)}</b>
                    </span>
                  ))}
                </div>
              </section>
            )}
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
         * 있을 땐 폭이 0이다. 예전에는 경기 무대와 장부 무대가 서로 다른 마크업이라
         * 킥오프·탭 조작마다 채팅이 통째로 다시 그려지며 **툭** 튀었다 — 격자 트랙이
         * 없다 생겼다 하면 폭을 이어서 애니메이션할 수도 없다.
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
            {showBoard && game.views.match ? (
              <div className="stage-board" data-testid="stage-board">
                {/* 탭이 바뀌면 이 덩어리가 새로 서며 흐려졌다 든다 — 판세와 명단은
                    생김새가 아주 달라서 즉시 갈리면 무엇이 바뀐 건지 읽히지 않는다 */}
                <div className="board-tab ledger-body" key={matchTab}>
                  {matchTab === "판세" && <MatchOverview match={game.views.match} />}
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
                          match={game.views.match}
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
               * 예전에는 패널이 무대를 통째로 덮었다. 그러면 명단을 확인하려고 연 순간
               * 대화가 사라지고, 감독은 "방금 코치가 뭐라고 했더라"를 확인하러 다시
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
                  {shownPanel === "달력" && <CalendarView calendar={game.views.calendar} />}
                  {shownPanel === "재정" && <FinanceView finance={game.views.finance} />}
                  {shownPanel === "대회" && competitionsView}
                  {shownPanel === "커리어" && (
                    <CareerView squad={game.views.squad} career={game.views.career} />
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
