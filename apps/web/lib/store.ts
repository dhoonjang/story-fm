import {
  buildOfficeViews,
  speakerRoles,
  type SpeakerRole,
  teamName,
  clockOf,
  formatClock,
  type GameState,
  type OfficeViews,
  type ChatTurn,
} from "@story-fm/engine";
import { STALLED_CLOCK_TURNS } from "@story-fm/agents";
import { buildPlayerNameIndex, playerIdsIn } from "./player-names";

/** 응답에 실을 장부 — 라우트가 **자기가 바꾼 것만** 고른다 */
export type ViewKey = keyof OfficeViews;

/**
 * 바뀐 뷰만 실은 응답 — 화면이 쥔 payload 위에 **뷰 단위로 얹힌다**.
 *
 * 전술판은 조작이 멎으면 저장하므로(`AUTOSAVE_MS`) 판을 짜는 동안 이 응답이 3초마다
 * 나간다. 그때마다 전체 payload를 돌려주면 화면이 `setGame`으로 통째로 갈리며
 * 채팅·순위·일정까지 다시 그려진다 — 감독은 전술판만 만졌는데.
 */
export interface GameSlice {
  id: string;
  /** 이 응답이 실은 뷰만 들어 있다 — 나머지는 화면이 쥔 것이 그대로 남는다 */
  views: Partial<OfficeViews>;
  /**
   * 서버가 아는 채팅 길이 — **턴이 지나간 뒤 닿은 조각을 가르는 자다.**
   *
   * 저장은 턴보다 앞선 상태에서 출발하므로 늦게 닿은 조각을 그대로 얹으면 방금 받은
   * 턴 결과를 되감는다. 조각에는 `chat`이 없으니(그게 여기 없는 이유다) 길이만 싣는다.
   */
  chatLength: number;
}

/** API 응답 페이로드 — 클라이언트가 소비하는 직렬화 가능한 뷰 모델 */
export interface GamePayload {
  id: string;
  date: string;
  /** 하루 안의 시각 — 헤더가 날짜 옆에 함께 보여 준다 (오전·오후·저녁) */
  timeOfDay: string;
  season: number;
  phase: string;
  teamName: string;
  managerName: string;
  chat: ChatTurn[];
  views: OfficeViews;
  /** 대화에 설 수 있는 선수 id→이름 — 서사에 흘러든 id의 클라이언트 치환용 */
  playerNames: Record<string, string>;
  /**
   * 화자 이름→직책 — 채팅이 `스티브 홀랜드 (수석코치)`로 보여 준다.
   * 모델은 이름만 뱉으므로 직책은 세이브가 알려 준다 (people.md §3).
   */
  speakerRoles: Record<string, SpeakerRole>;
  /**
   * **시계가 멎은 채 이어진 턴 수** — 모델의 첫 줄 헤더를 연달아 못 읽었다
   * (`STALLED_CLOCK_TURNS` 이상일 때만 실린다).
   *
   * 턴이 실패한 게 아니므로 오류 배너가 아니다. 화면이 사실 한 줄로 세워,
   * 세계가 오늘에 머물러 있다는 것이 감독에게 보이게 한다 (agents.md §2).
   */
  clockStalled?: number;
  /**
   * 접힌 경기 기록의 머리글 — `matchId` → 상대·스코어·날짜.
   *
   * 경기가 끝나면 그 구간의 중계·지시는 메인 채팅에서 **한 장으로 접힌다**. 그
   * 자리에 남는 카드가 무엇의 기록인지 말하려면 그 셋이면 된다 — 그 안을 되돌아보는
   * 것은 리포트가 갖는다 (match.md §8).
   */
  matchLogs: Record<string, { title: string; score: string | null; date: string }>;
}

/**
 * 선수 id처럼 생긴 토큰 — `arsenal-david-raya`. 사전에 없으면 그냥 두므로
 * `well-known` 같은 평범한 하이픈 단어를 잘못 건드릴 일은 없다.
 */
const ID_LIKE = /[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g;

/**
 * 서사에 흘러든 id를 이름으로 바꾸기 위한 사전 — **전 리그를 보내지 않는다.**
 *
 * 5,725명을 담으면 168KB이고, 그게 매 턴 응답에 실린다. 게다가 클라이언트가
 * 턴마다 사전 전체를 훑으므로 화면이 느려지는 값이기도 하다. 실제로 필요한 건
 * **우리 선수단**(대화의 대부분)과 **이미 대화에 나온 id**뿐이다 — 새 id가
 * 스트리밍 중에 튀어나와도 그 턴이 커밋되면 이 사전에 들어와 치환된다.
 *
 * 이 사전은 이제 **손잡이가 설 수 있는 이름의 폭**이기도 하다 (player.md §9.5) —
 * 화면은 여기 있는 이름만 누를 수 있게 잇는다. 그래서 이야기가 **이름으로** 부른
 * 남의 선수도 담는다: 이적 대상도 상대 팀 선수도 id 없이 산문에만 서므로, 위의
 * 토큰 훑기로는 영영 잡히지 않는다.
 *
 * 폭을 넓히되 짐은 그대로다 — 전 리그로 색인을 **한 번** 지어 대화가 부른 id만
 * 골라 담으므로, 나가는 것은 여전히 우리 선수단 + 이야기에 선 몇 명이다.
 * ⚠️ 색인은 payload 한 번에 한 번 짓는다(문장마다 지으면 5,725명짜리 사전을 한
 * 화면에 수백 번 짓는다), 그리고 **서버에만 남는다** — 클라이언트로 가는 것은
 * 여기서 만드는 id→이름 사전뿐이다.
 * ⚠️ **새로 담는 기준은 전체 이름이다** — 전 리그 색인에 낱말 하나짜리 열쇠를 두면
 * 수석코치 「스티브 홀랜드」의 「스티브」가 생판 남인 선수를 사전에 끌어들인다.
 * 낱말 하나로 부른 이름은 이미 사전에 선 사람에게만 걸린다 (화면이 그렇게 잇는다).
 */
function namesForChat(state: GameState): Record<string, string> {
  const mentioned = new Set<string>();
  const index = buildPlayerNameIndex(
    Object.fromEntries(state.players.map((p) => [p.id, p.name])),
    false,
  );
  for (const turn of state.chat) {
    for (const token of turn.text.match(ID_LIKE) ?? []) mentioned.add(token);
    for (const id of playerIdsIn(turn.text, index)) mentioned.add(id);
  }
  const names: Record<string, string> = {};
  for (const p of state.players) {
    if (p.teamId === state.userTeamId || mentioned.has(p.id)) names[p.id] = p.name;
  }
  return names;
}

/**
 * 화면에 세울 기록만 남긴다 — **감출 것은 코어가 표식으로 적어 둔다**(`silent`).
 *
 * 스킬 카탈로그의 이름만 남기면 코어가 남기는 기록이 함께 사라진다 — 경기 마감
 * (`finalize_match`)의 "경기 종료"가 그것이라, 90분이 무엇으로 끝났는지가 어느
 * 화면에도 서지 않았다. 무엇이 칩으로 설 만한 일인지는 그것을 남긴 코어가 알므로
 * 화면은 표식만 본다 (agents.md §2).
 *
 * 표식이 없던 시절의 기록은 이름밖에 없어 여기서 걸리지 않는다 — 그 유령 칩은
 * 화면이 이름으로 막는다(`chat.tsx`). 저장된 데이터는 건드리지 않고 **보여줄 때만**
 * 거른다.
 */
export function visibleChat(chat: readonly ChatTurn[]): ChatTurn[] {
  return chat.map((turn) => {
    if (turn.toolCalls === undefined || turn.toolCalls.length === 0) return turn;
    const kept = turn.toolCalls.filter((c) => c.silent !== true);
    return kept.length === turn.toolCalls.length ? turn : { ...turn, toolCalls: kept };
  });
}

/**
 * 채팅에 접혀 있는 경기들의 머리글 — 이력에 등장한 `matchId`만 만든다.
 *
 * **머리글이 전부다.** 득점·평점 상위는 여기서 접지 않는다: 같은 경기를 두 벌로
 * 접던 자리라, 이제 리포트 한 벌이 그 자리를 갖는다
 * (`GET /api/games/[id]/match-report/[matchId]` · match.md §8).
 */
function matchLogsOf(state: GameState): GamePayload["matchLogs"] {
  const ids = new Set(
    state.chat.map((t) => t.matchId).filter((id): id is string => typeof id === "string"),
  );
  const logs: GamePayload["matchLogs"] = {};
  if (ids.size === 0) return logs;
  const matchById = new Map(state.matches.map((m) => [m.id, m] as const));
  for (const id of ids) {
    const m = matchById.get(id);
    if (!m) continue;
    const ours = m.homeTeamId === state.userTeamId;
    const opponent = teamName(ours ? m.awayTeamId : m.homeTeamId);
    logs[id] = {
      title: `${ours ? "홈" : "원정"} · ${opponent}`,
      score: m.result ? `${m.result.homeGoals} : ${m.result.awayGoals}` : null,
      date: m.date,
    };
  }
  return logs;
}

/**
 * 상태를 응답으로 — **뷰를 고르면 그 뷰만 실은 조각이 나간다.**
 *
 * 고르지 않으면 전부다. 시간이 흐르는 길(턴)은 무엇이든 바꿀 수 있어 통째로 보내야
 * 하지만, 라우트는 자기가 무엇을 바꿨는지 안다 — 그만큼만 내려보낸다.
 */
export function toPayload(state: GameState): GamePayload;
export function toPayload(state: GameState, only: readonly ViewKey[]): GameSlice;
export function toPayload(state: GameState, only?: readonly ViewKey[]): GamePayload | GameSlice {
  if (only) {
    const views = buildOfficeViews(state);
    return {
      id: state.id,
      views: Object.fromEntries(only.map((key) => [key, views[key]])) as Partial<OfficeViews>,
      chatLength: state.chat.length,
    };
  }
  return {
    id: state.id,
    date: state.date,
    timeOfDay: formatClock(clockOf(state)),
    season: state.season,
    phase: state.phase,
    teamName: teamName(state.userTeamId),
    managerName: state.manager.name,
    chat: visibleChat(state.chat),
    views: buildOfficeViews(state),
    playerNames: namesForChat(state),
    speakerRoles: speakerRoles(state),
    ...((state.sceneHeaderMisses ?? 0) >= STALLED_CLOCK_TURNS
      ? { clockStalled: state.sceneHeaderMisses }
      : {}),
    matchLogs: matchLogsOf(state),
  };
}
