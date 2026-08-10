"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { GamePayload } from "@/lib/store";
import type { ChatTurn } from "@story-fm/engine";
import { ChatTurnView, turnStamp } from "./chat";
import { panelHintsOf } from "@/lib/panel-hints";
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
   * 전술판을 펼쳐 두었나 — **스쿼드가 채팅 옆에 설 수 있는지를 가른다.**
   *
   * 스쿼드가 통째로 반쪽에 들어오면 전술판이 200px로 눌려 아무 쓸모가 없다.
   * 감독이 채팅을 보며 곁눈질하는 것은 대개 명단이고(누가 부상인가, 폼이 어떤가),
   * 판을 만지는 것은 그 자체로 하나의 일이다. 그래서 명단이 먼저 서고, 판을
   * 펼치면 그때 화면을 통째로 쓴다. 선택은 기억한다 — 탭을 오갈 때마다 접히면
   * 판을 쓰는 감독이 매번 다시 편다.
   */
  const [boardOpen, setBoardOpen] = useState(false);
  /** 읽은 장부 알림 — 그 화면을 연 순간부터 다시 세우지 않는다 */
  const [seenHints, setSeenHints] = useState<string[]>([]);
  /**
   * 전술판에서 쌓인 조작 — 다음 턴에 함께 나간다 (대기 목록을 화면에 그리지는
   * 않는다: 판 자체가 바뀐 모습이 곧 표시다).
   */
  const ordersRef = useRef<string[]>([]);
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
      const orders = ordersRef.current;
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
      const optimistic = operator
        ? null
        : { role: "user" as const, text: message, toolCalls: [], at: game.date };
      if (optimistic) setGame((g) => (g ? { ...g, chat: [...g.chat, optimistic] } : g));

      /** 턴 실패 — 낙관적 유저 턴을 지우고 입력을 되돌린다 (채팅엔 아무것도 남기지 않는다) */
      const fail = (reason: string, detail?: string) => {
        // 실패한 턴은 없었던 일이 된다 — 지시도 대기함으로 돌려놓는다
        if (orders.length > 0) ordersRef.current = [...orders, ...ordersRef.current];
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
        // 새 턴이 왔으니 지난 알림의 "읽음"은 무효다 — 이번 턴 것을 다시 세운다
        if (payload) setSeenHints([]);
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
    for (let i = (game?.chat.length ?? 0) - 1; i >= 0; i--) {
      const stamp = turnStamp(game!.chat[i]!);
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
  const wide = panel === "스쿼드" || panel === "달력";

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
              />
            );
            prevStamp = turnStamp(turn) ?? prevStamp;
            return node;
          };
          return groupMatchTurns(game.chat).map((block, bi) => {
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
        <span className="meta" data-testid="team-name">
          {game.teamName}
        </span>
        <span className="meta hide-sm">{game.managerName} 감독</span>
        {/* 시즌 번호는 여기 두지 않는다 — 상단 바에서 매 순간 필요한 건 **지금이
            언제인가**뿐이고, 몇 번째 시즌인지는 커리어·대회 화면이 갖는다 */}
        {/* 경기 중에는 **경기 시계**가 이 자리를 쓴다 — 그때 필요한 시각은 그것이다 */}
        {game.views.match ? (
          <MatchClock match={game.views.match} />
        ) : (
          <span className="meta" data-testid="game-date">
            {game.date} {game.timeOfDay}
          </span>
        )}
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
            {PANELS.map(({ key, Icon }) => {
              const hint = hints.find((h) => h.panel === key);
              return (
                <span className="rail-slot" key={key}>
                  <button
                    className={`${panel === key ? "active" : ""}${hint ? " hinted" : ""}`}
                    onClick={() => {
                      setSeenHints((seen) => (seen.includes(key) ? seen : [...seen, key]));
                      setPanel(panel === key ? null : key);
                    }}
                    data-testid={`tab-${key}`}
                    title={key}
                    aria-label={hint ? `${key} — ${hint.lines.join(", ")}` : key}
                  >
                    <Icon />
                  </button>
                  {/**
                   * 바뀐 장부를 알리는 말풍선 — **읽으면 사라진다.**
                   * 채팅에 카드로 그리면 무대의 주인이 서사에서 대시보드로 넘어가고,
                   * 아무 표시도 없으면 지시가 먹혔는지 확인하러 탭을 열어야 한다.
                   */}
                  {hint && (
                    <span className="rail-hint" data-testid={`hint-${key}`} role="status">
                      {hint.lines.map((line, i) => (
                        <span className="rail-hint-line" key={i}>
                          {line}
                        </span>
                      ))}
                      {hint.more > 0 && <i>외 {hint.more}건</i>}
                    </span>
                  )}
                </span>
              );
            })}
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
        <div className="fulltime" data-testid="fulltime">
          <div className="fulltime-card">
            <span className="fulltime-tag">경기 종료</span>
            <b className="fulltime-score">{game.matchLogs[finished].score}</b>
            <span className="fulltime-title">{game.matchLogs[finished].title}</span>
            {game.matchLogs[finished].goals.length > 0 && (
              <div className="fulltime-goals">
                {game.matchLogs[finished].goals.map((g, i) => (
                  <span key={i}>{g}</span>
                ))}
              </div>
            )}
            {game.matchLogs[finished].best.length > 0 && (
              <div className="fulltime-best">
                {game.matchLogs[finished].best.map((b) => (
                  <span key={b.name}>
                    {b.name} <b>{b.rating.toFixed(1)}</b>
                  </span>
                ))}
              </div>
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
        {/* 무대 — 경기 중에는 판세와 중계가 나란히 선다. 감독은 왼쪽에서 읽고
            오른쪽에 지시한다 (탭을 오가며 상황을 기억하지 않아도 된다) */}
        {panel === null &&
          (game.views.match ? (
            /* 경기 — **채팅이 왼쪽**이다. 감독이 읽고 말하는 자리가 주인이다 */
            <div className="stage-split">
              {chatPane}
              <div className="stage-board" data-testid="stage-board">
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
                      <SquadView
                        game={game}
                        onUpdate={setGame}
                        onGoToChat={() => setMatchTab("판세")}
                        onOrder={(text) => {
                          ordersRef.current = [...ordersRef.current, text];
                        }}
                      />
                    ) : (
                      <MatchOpponent match={game.views.match} />
                    )}
                  </>
                )}
                {matchTab === "대회" && (
                  <CompetitionsView
                    competitions={game.views.competitions}
                    teamName={game.teamName}
                  />
                )}
              </div>
            </div>
          ) : (
            chatPane
          ))}

        {/**
         * 장부 뷰 — **채팅을 대신하지 않고 나눠 쓴다.**
         *
         * 예전에는 패널이 무대를 통째로 덮었다. 그러면 명단을 확인하려고 연 순간
         * 대화가 사라지고, 감독은 "방금 코치가 뭐라고 했더라"를 확인하러 다시 채팅을
         * 열어야 한다. 폭만 있으면 둘 다 서 있는 게 맞다 — 경기 중 무대가 이미
         * 그렇게 갈린다.
         *
         * **갈림은 CSS가 정한다.** 화면 폭을 자바스크립트로 재면 첫 렌더가 서버와
         * 어긋나고 창을 줄일 때마다 다시 그린다. 마크업은 언제나 둘이고, 좁은
         * 화면에서는 채팅 열이 접힌다(사라지는 게 아니라 접히는 것이라 스크롤
         * 위치와 쓰던 입력이 그대로 남는다).
         */}
        {panel !== null && (
          <div
            className={`stage-split panel-split${panel === "스쿼드" && boardOpen ? " board-open" : ""}`}
          >
            {chatPane}
            <section className={wide ? "panel wide" : "panel"} data-testid={`panel-${panel}`}>
              {/* 폭은 뷰가 정한다 — 전술판+명단(스쿼드)과 열두 달 격자(달력)는
                  본문 900px 안에 넣으면 읽을 수가 없다 */}
              <div
                className={`view-scroll${wide ? " wide" : ""}${panel === "스쿼드" ? " fill" : ""}`}
              >
                {panel === "스쿼드" && (
                  <SquadView
                    game={game}
                    onUpdate={setGame}
                    onGoToChat={() => setPanel(null)}
                    boardOpen={boardOpen}
                    onToggleBoard={() => setBoardOpen((open) => !open)}
                    /*
                     * 경기 중 전술판 조작 — **지시로 보낸다.** 판에서 손을 뗀 순간
                     * 채팅으로 돌아가 중계를 보게 한다: 지시의 결과는 거기서 나온다.
                     */
                    onOrder={
                      game.views.match
                        ? (text) => {
                            ordersRef.current = [...ordersRef.current, text];
                          }
                        : undefined
                    }
                  />
                )}
                {panel === "달력" && <CalendarView calendar={game.views.calendar} />}
                {panel === "재정" && <FinanceView finance={game.views.finance} />}
                {panel === "대회" && (
                  <CompetitionsView
                    competitions={game.views.competitions}
                    teamName={game.teamName}
                  />
                )}
                {panel === "커리어" && (
                  <CareerView squad={game.views.squad} career={game.views.career} />
                )}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
