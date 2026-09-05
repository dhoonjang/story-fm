/**
 * GM 입력 빌더 — 구단·감독 블록(캐시층)·상태 스냅샷·경기 장부 노트·장면 헤더 파서·
 * 이번 턴 메시지와 대화 이력 창. 입력은 변경 빈도 순 3층이다 (docs/llm/agents.md).
 */
import {
  awardLine,
  awardReachesManager,
  ABSENT_REASON_KO,
  boardExpectation,
  buildOpponentReport,
  callUpsOfBreak,
  careerTotalsOf,
  characterEntry,
  characterEntryOf,
  clockOf,
  clubHonoursLine,
  coachCues,
  describeActiveArcs,
  describeOpenings,
  computeStandings,
  dayOfWeek,
  describeBuyBackRights,
  describeInterests,
  describeNegotiations,
  describeNextFixture,
  describeBoardRequests,
  describePendingApproach,
  pendingApproach,
  describePendingPress,
  pendingPress,
  describeWindowState,
  expiringContracts,
  factSpeakerOf,
  financeOf,
  formatClock,
  headCoachOf,
  historyStart,
  injuryHistoryOf,
  internationalBreaksOf,
  isAvailableFor,
  nextMatchFor,
  isInjured,
  activeSuspension,
  suspensionScopeName,
  loanedOut,
  managedTeamId,
  MAX_EXPLOITS,
  missionReportLine,
  onSummerBreak,
  openCallUp,
  openInjury,
  openManagerOffers,
  openPromises,
  openTransferRequests,
  pendingContractOf,
  pendingVerdicts,
  ourYouthCandidates,
  playerName,
  recordBreakLine,
  recordBreaksOf,
  scoutingSummary,
  scoutReportLine,
  speakerCues,
  squadFamiliarity,
  squadLevelOf,
  squadReturnOf,
  subLimitsOf,
  tacticsOf,
  playersOf,
  teamName,
  topNarrative,
  userPlayers,
  VACANCY_KNOCK_DAYS,
  visionOf,
  visionReadings,
  visionSpanOf,
  visionYearOf,
  weeklyWagesOf,
  youthCandidateFog,
  youthIntakeDeadline,
  type ChatTurn,
  type CoachCue,
  type GameState,
  type ScenePoint,
} from "@story-fm/engine";
import {
  ageOf,
  associationName,
  boardExpectationLine,
  boardExpectationText,
  capsOf,
  internationalGoalsOf,
  naturalPositionOf,
  describeManagerSkills,
  describeReputation,
  diffDays,
  familiarityLabel,
  fatigueBand,
  fatigueOf,
  formatMoney,
  matchupText,
  mediaFactText,
  normalizePacket,
  packetTagContext,
  packetTagText,
  personaRoleLabel,
  PROMISE_KIND_KO,
  SET_PIECE_KO,
  SET_PIECE_ROUTINE_AXES,
  SET_PIECE_ROUTINE_NEUTRAL,
  setPieceRoutineLevel,
  setPieceRoutineWord,
  slotOfTime,
  TACTIC_TOGGLES,
  tacticToggleValue,
  tacticToggleWord,
  tacticsBrief,
  RELATION_TIER_KO,
  TRANSFER_REQUEST_REASON_KO,
  visionItemText,
  type CallUpReturnState,
  type GamePlayer,
  type MatchRecord,
  type TeamTalkOccasion,
  type CharacterEntry,
  type CharacterInjection,
  type ManagerOffer,
  type MissionReportCard,
  type PersonaRelation,
  type ScoutReportCard,
  injuryHistoryText,
} from "@story-fm/domain";

/** 경기 브리핑에 그대로 싣는 직전 평시 감독 발화 수 */
const MATCH_BRIEF_TURNS = 3;
/** 경기 다이제스트가 "방금 있었던 일"로 치는 기간 (일) */
const MATCH_DIGEST_DAYS = 3;
/** 계약 만료 임박 경고 창 (일) */
const EXPIRING_ALERT_DAYS = 180;

/**
 * 약속 기한 임박 경고 창 (일) — **계약보다 훨씬 짧다.**
 *
 * 계약 만료는 반년 전부터 손을 쓸 수 있는 일이지만 약속은 기한 그 주에 감독이
 * 할 수 있는 일(선발로 세운다·리스트에 올린다·재계약을 연다·완장을 채운다)이
 * 남아 있는 동안만 경고가 뜻을 갖는다. 한 달 전부터 매 턴 뜨면 그 줄은 배경음이
 * 되고, 정작 기한 전날의 줄이 묻힌다 (→ docs/data/people.md §5-2).
 */
const PROMISE_ALERT_DAYS = 7;

/**
 * 인물 카드 — 인물지를 모델이 읽는 형태로 (people.md §6).
 *
 * 예시 대사까지 실어야 모델이 톤을 흉내 내는 대신 그 사람으로 말한다. 무엇이 실리고
 * 무엇이 빠지는지는 **깊이**가 정하고, 그 판단은 코어(`characterEntry`)의 것이다 —
 * 여기서는 온 것을 문장으로 옮기기만 한다.
 *
 * ⚠️ **카드는 데이터다 — 지시문을 싣지 않는다** (prompts.md §5). 조회 포인터도
 * 실명 가드도 여기 없다: 규칙은 시스템 프롬프트가 한 번 갖고, 실명 인물의 사람됨은
 * 원형과 장부의 사실이 묶는다. 화자 태그는 여는 태그의 속성이다 — 태그와 이름이
 * 갈리는 동명이인에서 모델이 태그를 알 자리가 여기뿐이다.
 *
 * 블록은 영어 태그로 싼다 (prompts.md §5) — 읽는 것(꺾쇠)과 쓰는 것(@ 줄)이 갈린다.
 */
/**
 * 관계 한 줄 — 근거가 있으면 함께 적는다.
 *
 * **감독이 붙여 준 사이**(멘토링 — people.md §5-3)에는 원형 축이 없다: 그 자리에
 * 섰다는 사실 하나가 근거다. **원형에서 시작한 사이**는 먼저 보는 것을 함께 든다.
 * 어느 쪽이든 앞에 서는 것은 지금의 등급이고, 등급이 빠지는 것은 가운데 둘
 * (`distant`·`cordial`)일 때다 — 결이 서지 않는 사이는 카드에 등급을 세우지 않는다.
 */
function relationLine(r: PersonaRelation): string {
  const grade = r.tier ? RELATION_TIER_KO[r.tier] : null;
  if (r.bond) {
    const seat = r.bond === "mentor" ? "멘토" : "멘티";
    return `관계: ${r.name} — 감독이 붙여 준 사이 (내가 ${seat})${grade ? ` · ${grade}` : ""}`;
  }
  const axes = r.ours && r.theirs ? ` (먼저 보는 것: 나 ${r.ours} · 상대 ${r.theirs})` : "";
  return `관계: ${r.name} — ${grade ?? (r.stance === "aligned" ? "결이 맞는다" : "결이 부딪힌다")}${axes}`;
}

export function describePersona(entry: CharacterEntry): string {
  const label = personaRoleLabel(entry.role);
  return [
    `<character name="${entry.name}" tag="@${entry.characterId}:"${label ? ` role="${label}"` : ""}>`,
    `원형: ${entry.archetype}`,
    `성격: ${entry.traits.join(" · ")}`,
    ...(entry.motivation ? [`동기: ${entry.motivation}`] : []),
    ...(entry.speechStyle ? [`말투: ${entry.speechStyle.note}`] : []),
    ...(entry.speechStyle?.samples ?? []).map((s) => `  예) ${s}`),
    // 관계 — **지금의 등급**이다 (people.md §6 「관계 등급」). 숫자는 싣지 않는다:
    // 카드는 이력에 굳으므로 매 턴 달라지는 값을 실으면 지난 턴들의 바이트가 함께 바뀐다
    ...(entry.relations ?? []).map((r) => relationLine(r)),
    // 감독이 아는 만큼만 그린다 — 소문으로만 아는 사람에게 속내를 주면 만난 적 없는
    // 사람의 목소리가 난다. 사실로 적는다: 카드의 지시문은 모델이 그 문장대로 쓴다
    ...(entry.depth === "rumour" ? [`감독과의 거리: 평판으로만 안다 — 말투도 속내도 모른다`] : []),
    // 기억은 **이번 턴에 세우는 카드에만** 온다 — 이력이 다시 그리는 카드
    // (`characterEntryOf`)는 기억 없이 오므로 이 줄이 서지 않는다. 압축이 더한 기억이
    // 지난 턴의 바이트를 바꾸지 않는 자리다 (people.md §6 · agents.md §5)
    ...(entry.memories?.length
      ? [`있었던 일:`, ...entry.memories.map((m) => `  ${m.date} — ${m.text}`)]
      : []),
    `</character>`,
  ].join("\n");
}

/**
 * 이번 장면의 인물들 — 인물 사전이 고른 카드 묶음 (people.md §6).
 *
 * ⚠️ **여기 있는 것은 "이 사람이 누구인가"뿐이다.** 카드는 이력에 굳으므로 변하는
 * 값(폼·컨디션·부상·심경·계약)이 들어가면 3주 뒤 모델이 낡은 사실로 말한다. 지금의
 * 사실은 조회 도구가 갖고, **조회하고 답하라는 지시는 이 블록이 아니라 `GM_SYSTEM`의
 * 철칙과 그 도구의 설명이 갖는다** — 카드에는 사실만 선다 (prompts.md §5).
 */
export function describeCharacters(entries: readonly CharacterEntry[]): string | null {
  if (entries.length === 0) return null;
  return [`<characters>`, ...entries.map(describePersona), `</characters>`].join("\n");
}

/**
 * 맡은 구단 — 이름은 여는 태그의 속성이다 (`<character name>`과 같은 표기, prompts.md §5).
 * 무직이면 서지 않는다 — 옛 구단을 세우면 모델은 아직 그 구단의 감독인 것처럼 쓴다
 * (career.md §5.1). 경질·부임에 한 번 바뀌고 그 사이엔 바이트가 같다.
 *
 * **역대 한 줄이 본문에 선다** (team.md §1) — 이 구단이 무엇을 든 구단인가는 세계가
 * 아는 사실이라, 없으면 GM이 지어낸다. 우승이 없거나 시드가 없는 구단은 줄이 서지
 * 않는다: 없는 것은 0회가 아니라 모르는 것이다. **시즌에 한 번**(우승이 하나 늘 때)만
 * 바뀌므로 캐시 프리픽스는 시즌 롤오버에만 깨진다.
 */
export function describeClub(state: GameState): string | null {
  const teamId = managedTeamId(state);
  if (teamId === null) return null;
  const honours = clubHonoursLine(state, teamId);
  return honours === null
    ? `<club name="${teamName(teamId)}" />`
    : [`<club name="${teamName(teamId)}">`, `역대: ${honours}`, `</club>`].join("\n");
}

/**
 * 감독 — 이름과 화자 태그는 속성, 배경은 본문. 세이브당 고정인 것만이다.
 *
 * **데이터만 싣는다** (prompts.md §5). 선수 이름이 스냅샷에 있다는 것, 선수 인자는
 * 이름으로 받는다는 것, 감독을 대신 연기하지 않는다는 것은 전부 시스템 프롬프트가
 * 한 번 갖는 규칙이라 여기 다시 적지 않는다 (prompts.md §5-3).
 * ⚠️ 감독의 능력·평판은 여기 없다 — 경기마다 평판이 움직이고 능력도 자라므로
 * 여기 있으면 경기 한 번에 이 블록과 그 뒤가 통째로 무효가 된다. 매 턴
 * 층(`buildGmStateNote`)이 구간 어휘로 싣는다.
 */
export function describeManager(
  manager: Pick<GameState["manager"], "name" | "background">,
): string {
  return [
    `<manager name="${manager.name}" tag="@${manager.name}:">`,
    `배경: ${manager.background}`,
    `</manager>`,
  ].join("\n");
}

/**
 * 레퍼런스 층 — 캐시되는 시스템 블록. 구단과 감독, 세이브당 고정인 것만 (agents.md §5).
 * 세 에이전트(평시 GM · 중계 · 교섭)가 같은 두 블록을 읽는다.
 *
 * ⚠️ **인물 카드는 여기 없다.** 코치·구단주·기자 다섯 장은 회견도 협상도 없는 턴에
 * 한 번도 쓰이지 않는데 매 턴 읽혔다. 그렇다고 조건부로 넣었다 뺐다 하면 더 나쁘다 —
 * 프리픽스가 바뀌는 턴마다 이 블록과 그 뒤 이력이 통째로 무효가 된다. 카드는 인물 사전이
 * 골라 **이번 턴 층**에 싣고 다음 턴부터 이력의 일부가 된다 (people.md §6).
 * ⚠️ 선수의 이름도 id도 여기 두지 않는다 — 명단은 영입·매각·2군 승격·주장 변경마다
 * 바뀌고, 한 줄이 달라지면 이 블록과 그 뒤의 이력이 통째로 무효가 된다. 이름은 매 턴
 * 층(`buildGmStateNote`)의 「선수단」 줄이 싣는다.
 */
export function buildGmReference(state: GameState): string {
  return [describeClub(state), describeManager(state.manager)]
    .filter((block): block is string => block !== null)
    .join("\n\n");
}

/**
 * 요약 블록 — **레퍼런스 뒤·이력 앞**의 세 번째 시스템 블록 (agents.md §5·§5-1).
 *
 * 압축된 세이브에만 선다. 레퍼런스에 섞지 않는 이유는 자리에 있다: 여기 따로 세우면
 * 압축이 일어난 턴에만 그 뒤가 무효가 되고, 압축은 드물다.
 */
export function buildGmDigest(state: GameState): string | null {
  const digest = state.historyDigest;
  if (!digest) return null;
  // 무엇의 요약인지는 시스템 프롬프트의 「입력」이 말한다 — 블록은 날짜와 두 칸뿐이다.
  // 옛 세이브의 요약은 열린 일이 없다 — 그때는 지난 일 한 칸이다
  return [
    `<summary at="${digest.at}">`,
    `지난 일: ${digest.text}`,
    ...(digest.open ? [`열린 일: ${digest.open}`] : []),
    `</summary>`,
  ].join("\n");
}

/** 유저의 자연어를 모델이 읽는 감독 화자 형식으로 감싼다. */
export function buildManagerMessage(state: GameState, message: string): string {
  return `@${state.manager.name}: ${message}`;
}

/**
 * 화면 조작 — 감독의 발화가 아니다. **모델의 출력 문법 밖 봉투로 싣는다**
 * (`<operator>시간 진행 — 하루</operator>`). `@:`는 GM이 내레이션을 쓰는 채널이라 거기 담으면
 * 감독의 화면 조작이 모델 자신의 문법으로 이력에 서고, 인물이 그 손잡이를 아는
 * 것으로 읽힌다 (docs/llm/prompts.md §1).
 */
export function buildOperatorMessage(message: string): string {
  return `<operator>${message}</operator>`;
}

/**
 * 경기 캐시 레퍼런스 — 경기 내내 변하지 않는 것만 담는다. 구단·감독은 평시와 같은
 * 두 블록이다.
 * ⚠️ 패킷은 매 구간 갱신되므로 여기 두면 캐시 프리픽스가 매 턴 깨진다 —
 * 휘발 채널(`buildLedgerNote`)로 내려간다.
 */
export function buildMatchReference(state: GameState): string {
  return [
    buildGmReference(state),
    // 벤치에서 감독 옆에 서 있는 사람이다 — 경기 중 조언도 같은 사람의 말투여야 한다.
    // 경기 내내 같은 한 사람이라 여기서는 인물 사전을 거치지 않고 상주한다
    describeCharacters([characterEntry(headCoachOf(state), "full")]),
    buildMatchBrief(state),
  ]
    .filter((block): block is string => block !== null && block.length > 0)
    .join("\n\n");
}

/**
 * 평시 → 경기 다리 — 직전 평시 턴의 감독 발화를 **그대로** 싣는다
 * (중계는 평시 이력을 보지 않고, 요약은 말투·의도를 가장 먼저 지운다).
 */
export function buildMatchBrief(state: GameState): string {
  const said = state.chat
    .filter((t) => t.inMatch !== true && t.role === "user")
    .slice(-MATCH_BRIEF_TURNS)
    .map((t) => `- "${t.text}"`);
  if (said.length === 0) return "";
  return [`<pre_match>`, ...said, `</pre_match>`].join("\n");
}

const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];

/** 팀토크 자리 — 다이제스트 줄에 한글로 선다. 판정(outcome)은 코드 그대로다 */
const TEAM_TALK_OCCASION_KO: Record<TeamTalkOccasion, string> = {
  pre: "경기 전",
  half: "하프타임",
  post: "경기 후",
  daily: "훈련장",
  shout: "외침",
};

/** 그 경기의 채팅 턴 — 표식이 있으면 경기 id로, 없으면(옛 세이브) 날짜로 가른다 */
function turnsOfMatch(state: GameState, match: MatchRecord): ChatTurn[] {
  return state.chat.filter(
    (t) =>
      t.inMatch === true &&
      (t.matchId !== undefined ? t.matchId === match.id : t.at === match.date),
  );
}

/**
 * 라커룸의 결과 — 그 경기의 팀토크 자리와 판정. 호출 기록의 입력(`team_talk`)에서
 * 읽는다: 코어가 적은 사실이지 중계 문장이 아니다.
 *
 * ⚠️ **방 전체에 한 말만 센다.** 대화 도구 하나가 이름을 부른 말도 나르므로(`players`),
 * 그것까지 세면 한 선수와 나눈 하프타임의 말이 라커룸 전체의 판정으로 선다.
 */
function lockerRoomLine(turns: readonly ChatTurn[]): string | null {
  const talks: string[] = [];
  for (const call of turns.flatMap((t) => t.toolCalls)) {
    if (call.name !== "team_talk") continue;
    const input = call.input as
      { occasion?: unknown; outcome?: unknown; players?: unknown } | undefined;
    if (Array.isArray(input?.players) && input.players.length > 0) continue;
    if (typeof input?.occasion !== "string" || typeof input.outcome !== "string") continue;
    const occasion = (TEAM_TALK_OCCASION_KO as Record<string, string>)[input.occasion];
    talks.push(`${occasion ?? input.occasion} 팀토크 ${input.outcome}`);
  }
  return talks.length > 0 ? `- 라커룸: ${talks.join(" · ")}` : null;
}

/**
 * 그라운드를 떠난 우리 선수 — 퇴장·부상·교체. 장부의 사건 목록(`result.events`)이
 * 원본이고, 사건이 남지 않은 옛 세이브는 그 턴의 카드·부상 기록·교체 명령 입력으로
 * 떨어진다. 없으면 줄을 세우지 않는다.
 */
function departedLine(
  state: GameState,
  match: MatchRecord,
  turns: readonly ChatTurn[],
  ours: "home" | "away",
  nameOf: (id: string) => string,
): string | null {
  const isOurs = (id: string) =>
    state.players.find((p) => p.id === id)?.teamId === state.userTeamId;
  const mark = (label: string, id: string, minute?: number) =>
    `${label} ${nameOf(id)}${minute !== undefined ? `(${minute}′)` : ""}`;
  const parts: string[] = [];
  const events = match.result?.events;
  if (events) {
    for (const e of events) {
      if (e.team !== ours) continue;
      const who = e.actors[0];
      if (!who) continue;
      if (e.type === "red_card") parts.push(mark("퇴장", who, e.minute));
      else if (e.type === "injury") parts.push(mark("부상", who, e.minute));
      else if (e.type === "substitution") parts.push(mark("교체 아웃", who, e.minute));
    }
  } else {
    for (const t of turns) {
      for (const card of t.cards ?? []) {
        if (card.ours && card.kind !== "yellow") parts.push(mark("퇴장", card.player, card.minute));
      }
      for (const call of t.toolCalls) {
        const input = call.input as { out?: unknown } | undefined;
        if (call.name === "substitute" && typeof input?.out === "string") {
          parts.push(mark("교체 아웃", input.out));
        }
      }
    }
    for (const injury of state.injuries) {
      if (
        injury.cause === "match" &&
        injury.occurredOn === match.date &&
        isOurs(injury.gamePlayerId)
      ) {
        parts.push(mark("부상", injury.gamePlayerId));
      }
    }
  }
  return parts.length > 0 ? `- 나간 사람: ${parts.join(" · ")}` : null;
}

/**
 * 경기 → 평시 다리 — 직전 경기의 결과·득점·최고 평점에 라커룸의 결과와 그라운드를
 * 떠난 사람을 코어가 장부에서 뽑는다 (평시 GM은 중계 이력을 보지 않는다 — agents.md §5).
 * 직전 한 경기만 — 그 이상은 get_league의 몫.
 */
function matchDigest(state: GameState): string | null {
  const played = state.matches
    .filter(
      (m) =>
        m.result !== null &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (!played?.result) return null;
  if (dayGap(played.date, state.date) > MATCH_DIGEST_DAYS) return null;

  const ours = played.homeTeamId === state.userTeamId;
  const opponent = teamName(ours ? played.awayTeamId : played.homeTeamId);
  const us = ours ? played.result.homeGoals : played.result.awayGoals;
  const them = ours ? played.result.awayGoals : played.result.homeGoals;
  const verdict = us > them ? "승" : us === them ? "무" : "패";
  const nameOf = (pid: string) => state.players.find((p) => p.id === pid)?.name ?? pid;
  const scorers = played.result.scorers
    .map((tag, i) => {
      const minute = played.result?.goalMinutes?.[i];
      return `${minute !== undefined ? `${minute}′ ` : ""}${nameOf(tag.split(":")[1] ?? tag)}`;
    })
    .join(", ");
  const best = Object.entries(played.result.ratings ?? {})
    .filter(([pid]) => state.players.find((p) => p.id === pid)?.teamId === state.userTeamId)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_RATED_SHOWN)
    .map(([pid, r]) => `${nameOf(pid)} ${r.toFixed(1)}`)
    .join(", ");
  const turns = turnsOfMatch(state, played);
  return [
    `${played.date} ${ours ? "홈" : "원정"} vs ${opponent} ${us}-${them} ${verdict}`,
    scorers ? `- 득점: ${scorers}` : null,
    best ? `- 최고 평점: ${best}` : null,
    lockerRoomLine(turns),
    departedLine(state, played, turns, ours ? "home" : "away", nameOf),
  ]
    .filter(Boolean)
    .join("\n");
}

/** 두 날짜 사이의 일수 */
function dayGap(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000,
  );
}

/** 이번 턴 직전에 코어가 흘려 보낸 시간 — 손잡이로 넘겼을 때만 실린다 */
export interface TimePassed {
  from: string;
  stopped: string;
  digest: string[];
}

/**
 * 상태 스냅샷 — 매 턴 새로 주입되는 휘발성 블록 (role:"system" 오퍼레이터 채널).
 * phase 같은 내부 enum은 넣지 않는다 — 라우팅용 값이지 모델이 읽을 정보가 아니다.
 */
/**
 * 상태 노트가 프롬프트에 싣는 꼬리 길이.
 *
 * 전부 실으면 매 턴 같은 목록이 길게 반복돼 캐시 뒤가 무거워지고, 정작 이번 턴에
 * 달라진 것이 묻힌다 — 모델이 읽을 만큼만 남기고 나머지는 화면이 보여 준다.
 */
const TOP_RATED_SHOWN = 2;
const TRAINING_SHOWN = 3;

/** 훈련 해석기가 읽는 예정 훈련 수 — 주간 일정을 통째로 보고 겹침을 판단한다 */
const TRAINING_SCHEDULE_SHOWN = 20;

/**
 * 예정된 훈련 줄 — 스냅샷의 요약(`TRAINING_SHOWN`)과 훈련 해석기의 `<schedule>`이
 * **같은 함수를 읽는다.** 두 벌이면 화면이 말하는 일정과 해석기가 읽는 일정이 갈린다.
 */
export function upcomingTrainingLines(state: GameState, limit = TRAINING_SHOWN): string[] {
  return state.schedule
    .filter((e) => e.type === "training" && e.status === "scheduled" && e.date >= state.date)
    .slice(0, limit)
    .map((e) => {
      const s = state.trainingSessions.find((x) => x.id === e.refId);
      return `${e.date.slice(5)} ${slotOfTime(e.time) === "am" ? "오전" : "오후"} ${s?.label ?? "훈련"}`;
    });
}

/** 훈련 해석기의 `<schedule>` 본문 — 없으면 빈 문자열 */
export function buildTrainingSchedule(state: GameState): string {
  return upcomingTrainingLines(state, TRAINING_SCHEDULE_SHOWN)
    .map((line) => `- ${line}`)
    .join("\n");
}
const EXPIRING_SHOWN = 3;
/**
 * 떠나기로 한 선수를 몇 명까지 이름으로 적나 — **만료 임박보다 짧다.** 그 자리는
 * 감독이 아직 할 일이 있는 목록이라 길이가 뜻을 갖지만, 이쪽은 이미 끝난 일이라
 * 「몇 명이고 누가 먼저 가는가」면 족하다 (transfer.md §1-4).
 */
const PRECONTRACTED_SHOWN = 2;
const PROMISE_SHOWN = 3;
const TRANSFER_REQUEST_SHOWN = 3;
const AT_RISK_SHOWN = 3;
/** 과부하로 이름을 적는 인원 — 위험 줄과 같은 폭 */
const OVERLOADED_SHOWN = 3;
const RECENT_NARRATIVE = 4;

/**
 * 최근 사건 — 최신 4건이 아니라 **salience×recency 가중 상위 4건**이다 (people.md §9).
 * 고르는 눈금은 코어의 것(`topNarrative`)이고, 여기서는 줄로 옮기기만 한다.
 */
function recentNarrativeLines(state: GameState): string[] {
  return topNarrative(state, RECENT_NARRATIVE).map((n) => `${n.date} ${n.text}`);
}

/**
 * 스냅샷 안의 한 덩어리 (prompts.md §5-1 · agents.md §6).
 *
 * 한 턴에 열댓 덩어리가 쌓이는 블록이라 레이블 줄로는 경계가 서지 않는다. 규칙은
 * 둘이다 — **내용이 없으면 태그도 서지 않고**, 여는 태그가 이름을 대므로 **같은
 * 말을 하는 레이블 줄을 안에 다시 적지 않는다**.
 */
function block(tag: string, body: string | null, attrs = ""): string | null {
  if (body === null || body.trim().length === 0) return null;
  return `<${tag}${attrs}>\n${body}\n</${tag}>`;
}

/** 여러 줄을 한 덩어리로 — null과 빈 줄은 걷는다 */
function lines(...items: (string | null)[]): string {
  return items.filter((x): x is string => x !== null && x !== "").join("\n");
}

/**
 * 코치가 먼저 짚는 사실 — **이름이 태그의 속성으로 선다.** 안쪽 줄에 `이름:`을
 * 적으면 모델의 발화 문법(`@이름:`)과 한 글자 차이라, 코어가 낸 사실 줄이 코치가
 * 이미 한 말처럼 읽힌다 (prompts.md §5-1과 같은 이유로 회견·다가옴도 속성을 쓴다).
 *
 * **화자마다 한 덩어리다** — 원형이 고른 사실은 수석코치의 것이고, 훈련장·2군·임대는
 * 훈련장을 맡은 코치의 것이다 (people.md §3 화자 표). 태그는 같고 속성이 다르다.
 * 자리가 비어 두 갈래의 화자가 같은 사람이면 덩어리도 하나다 — 같은 이름으로 두 번
 * 서면 한 사람이 둘로 읽힌다. 순서는 코어가 정한 사실의 순서 그대로다.
 */
function coachBlocks(state: GameState, cues: readonly CoachCue[]): (string | null)[] {
  const byName = new Map<string, string[]>();
  for (const cue of cues) {
    const name = factSpeakerOf(state, cue.by === "coach" ? "training" : "coach_eye").name;
    byName.set(name, [...(byName.get(name) ?? []), `- ${cue.fact}`]);
  }
  return [...byName].map(([name, facts]) => block("coach", facts.join("\n"), ` name="${name}"`));
}

/**
 * 경기 전 상대 분석이 스냅샷에 서는 창 (일) — **전날과 당일뿐이다.**
 *
 * 감독이 라인업과 6축을 정하는 자리라 그날만 값이 있다. 사흘 전부터 매 턴 실으면
 * 캐시 밖 층을 상대 명단이 통째로 먹는다 (→ docs/llm/agents.md §6).
 */
const OPPONENT_BRIEF_DAYS = 1;

/**
 * 경기 전날·당일의 상대 분석 — **코어의 리포트를 그대로 옮긴다**
 * (→ docs/simulation/match.md §1.8). 지점의 수를 여기서 다시 자르지 않는다:
 * 몇 개가 보이는지는 감독의 **분석**이 이미 정한 값이고, 블록이 또 자르면
 * 손잡이가 둘이 된다.
 *
 * ⚠️ 데이터 블록이라 사실만 싣는다 — 지시문도 도구 이름도 없다 (prompts.md §5-3).
 */
function opponentBlock(state: GameState): string | null {
  const report = buildOpponentReport(state, { withinDays: OPPONENT_BRIEF_DAYS });
  if (!report) return null;
  const venue = report.venue === "home" ? "홈" : report.venue === "away" ? "원정" : "중립";
  const guessed = report.expectedXI.filter((p) => !p.carried).length;
  return block(
    "opponent",
    lines(
      `${report.date} ${report.time} ${report.label} · ${venue} vs ${report.opponent.name}` +
        `${report.inDays === 0 ? " (오늘)" : " (내일)"}`,
      `예상 XI: ${report.expectedXI.map((p) => `${p.name}(${p.position})`).join(" · ")}`,
      report.basis === null
        ? "예상의 근거: 상대의 직전 경기가 없다 — 배치에서 세운 추정이다"
        : `예상의 근거: 상대의 직전 경기(${report.basis.date} ${report.basis.label}) 선발` +
            `${guessed > 0 ? ` · ${guessed}명은 추정으로 메웠다` : ""}`,
      report.absent.length === 0
        ? "상대 결장: 없다"
        : `상대 결장: ${report.absent
            .map((a) => `${a.name} ${ABSENT_REASON_KO[a.reason]}(${a.note})`)
            .join(" · ")}`,
      `상대 전술: ${tacticsBrief(report.shape)}`,
      report.notes.length === 0
        ? "읽어 낸 지점: 없다"
        : lines(
            "읽어 낸 지점:",
            ...report.notes.map(
              (tag) =>
                `- [${tag.favours === report.ourSide ? "우리" : tag.favours === null ? "중립" : "상대"}] ` +
                packetTagText(tag, report.tagContext),
            ),
          ),
    ),
  );
}

/**
 * 회견·찾아온 사람 — **id가 태그의 속성으로 선다.** 답할 자리라 모델이 그 id를
 * 명령 인자로 되돌려 주어야 하고, 여는 태그가 이름을 대므로 안쪽 첫 줄은 맥락부터
 * 시작한다 (prompts.md §5-1).
 */
function pressBlock(state: GameState): string | null {
  const open = pendingPress(state);
  return open ? block("press", describePendingPress(state), ` id="${open.id}"`) : null;
}

function approachBlock(state: GameState): string | null {
  const open = pendingApproach(state);
  return open ? block("approach", describePendingApproach(state), ` id="${open.id}"`) : null;
}

/** 시간이 흘렀다 — 손잡이로 넘긴 턴에만 붙는 덩어리. 재직·무직 스냅샷이 같이 쓴다 */
function timePassedLine(state: GameState, passed?: TimePassed | null): string | null {
  if (!passed || (passed.digest.length === 0 && passed.from === state.date)) return null;
  return lines(
    `${passed.from} → ${state.date} (${passed.stopped}) — 장면은 ${state.date}에서 연다.`,
    passed.digest.length > 0
      ? passed.digest.map((d) => `- ${d}`).join("\n")
      : `그 사이 특별한 일은 없었다.`,
  );
}

/**
 * **감독 자신의 계약 한 줄** — 연봉과 만료일, 그리고 보드가 만료 90일 전에 내린
 * 판정 (career.md §5.4).
 *
 * 잔여일은 만료일에서 나오는 파생값이라 싣지 않는다. 열린 제안은 아래
 * `managerSeatLines`가 갈래마다 한 줄로 세운다.
 */
function managerContractLine(state: GameState): string | null {
  const contract = state.manager.contract;
  if (!contract) return null;
  const base = `감독 계약: 연봉 ${formatMoney(contract.salary)} · ${contract.until}까지`;
  return contract.renewalOffered === false
    ? `${base} · 보드는 재계약하지 않기로 했다 — 만료일에 자리를 잃는다`
    : base;
}

/**
 * 제안이 부른 자리 — 어느 구단이 어떤 자리로 부르는가 (career.md §5.1).
 * 무직의 목록과 재직 중의 줄이 같은 함수를 읽는다.
 */
function offerSeat(offer: ManagerOffer): string {
  return [
    `${teamName(offer.teamId)} (${offer.tier}티어)`,
    `기대 ${offerExpectation(offer)}`,
    offer.position ? `현재 ${offer.position}위` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");
}

/** 제안이 들고 온 조건과 기한 — 자리와 마찬가지로 두 스냅샷이 같은 것을 읽는다 */
function offerTerms(offer: ManagerOffer): string {
  return [
    offer.salary
      ? `연봉 ${formatMoney(offer.salary)}·${offer.years ?? "-"}년·이적 예산 약속 ${formatMoney(offer.budgetPledge ?? 0)}`
      : null,
    // 보상금은 감독의 지갑을 지나지 않는다 — 새 구단이 지금 구단에 무는 돈이다
    offer.compensation ? `지금 구단에 보상금 ${formatMoney(offer.compensation)}` : null,
    offer.counteredOn ? `흥정은 끝났다 — 수락 여부만 남았다` : null,
    `${offer.expiresOn}까지`,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");
}

/** 제안이 선 갈래 — 재직 중에는 갈래가 곧 사실이다 (career.md §5.1) */
const OFFER_VIA_KO: Record<NonNullable<ManagerOffer["via"]>, string> = {
  renewal: "보드의 재계약 제안",
  poach: "다른 구단의 접근",
  knock: "두드린 자리의 제안",
  vacancy: "감독직 제안",
};

/** 두드릴 수 있는 공석 한 줄씩 — 무직의 명부와 재직 중의 줄이 같은 것을 읽는다 */
function vacancyRows(state: GameState): string[] {
  return (state.managerVacancies ?? []).map(
    (v) => `- ${teamName(v.teamId)}${v.position ? ` · 현재 ${v.position}위` : ""} · ${v.on} 공석`,
  );
}

/**
 * **재직 중인 감독의 거취** — 열린 감독직 제안과 두드릴 수 있는 공석
 * (career.md §5.1 「재직 중 접근·노크」 · §5.4).
 *
 * 열흘이면 사라지는 답할 자리라 스냅샷에 서야 한다 — 화면에만 있으면 모델은 감독이
 * 무엇을 두고 답하는지 모른 채 장면을 쓴다. 갈래는 셋이다: 보드의 재계약, 다른
 * 구단의 접근, 감독이 두드려 얻은 자리.
 *
 * 재계약은 구단도 자리도 그대로라 구단·기대를 다시 적지 않는다 — 바로 위의 보드
 * 기대 줄이 그것이다.
 */
export function managerSeatLines(state: GameState): string[] {
  const offers = openManagerOffers(state).map((o) =>
    o.via === "renewal"
      ? `${OFFER_VIA_KO.renewal}: ${o.id} · ${offerTerms(o)}`
      : `${OFFER_VIA_KO[o.via ?? "vacancy"]}: ${o.id} · ${offerSeat(o)} · ${offerTerms(o)}`,
  );
  const vacancies = vacancyRows(state);
  return vacancies.length > 0
    ? [...offers, `공석 (경질 뒤 ${VACANCY_KNOCK_DAYS}일 안):`, ...vacancies]
    : offers;
}

/**
 * **무직의 스냅샷** — 맡은 팀이 없다 (career.md §5.1).
 *
 * 재직 중에 실리는 것(전술·재정·선수단·훈련·협상)은 전부 **옛 구단의 것**이라,
 * 그대로 실으면 모델은 아직 그 구단의 감독인 것처럼 장면을 쓴다. 무직에게 필요한
 * 것은 셋뿐이다 — 왜 무직인가, 무엇이 걸려 있는가, 그 사이 무슨 일이 있었는가.
 */
/**
 * 제안에 걸린 기대 한 줄 — **코드가 원본이고 문장은 폴백이다** (career.md §5.1).
 * 새 제안은 갈래 코드만 적으므로, 옛 세이브의 문장을 먼저 읽으면 새 제안이 빈칸으로 선다.
 */
function offerExpectation(offer: ManagerOffer): string {
  return offer.expectationCode
    ? boardExpectationText(offer.expectationCode, offer.target)
    : `${offer.expectation ?? "-"}(${offer.target}위)`;
}

function buildUnemployedNote(state: GameState, passed?: TimePassed | null): string {
  const card = state.dismissal;
  const offers = openManagerOffers(state);
  const vacancies = state.managerVacancies ?? [];
  const recent = recentNarrativeLines(state);
  return [
    `<snapshot>`,
    block(
      "now",
      lines(
        `${state.date} (${DOW_KO[dayOfWeek(state.date)]}) ${formatClock(clockOf(state))} · 시즌 ${state.season} · ${describeWindowState(state)}`,
        // 팀의 도구가 막힌다는 말은 싣지 않는다 — 코어가 부르는 자리에서 막는다 (prompts.md §5-3)
        `감독 ${state.manager.name}은(는) 무직이다 — 맡은 팀이 없다.`,
        card
          ? `${card.kind === "expired" ? "계약 만료" : "경질"}: ${card.on} ${teamName(card.teamId)}${
              card.expectation && card.position
                ? ` — 기대 ${card.expectation}(${card.target}위)에 최종 ${card.position}위`
                : card.reason
                  ? ` — ${card.reason}`
                  : ""
            }`
          : null,
      ),
    ),
    block("manager", `평판: ${describeReputation(state.manager.reputation)}`),
    /**
     * **마주 앉은 자리** — 무직에게 열릴 수 있는 다가옴은 감독직 면접 하나다
     * (career.md §5.1). 제안 목록보다 앞인 것은 답할 자리가 먼저이기 때문이다:
     * 이 자리가 열려 있는 동안에는 새 제안도 새 지원도 서지 않는다.
     */
    approachBlock(state),
    // 제안이 없는 것도 무직에겐 사실이다 — 기다리는 중인지 고를 자리가 있는지가 갈린다
    block(
      "job_offers",
      offers.length > 0
        ? offers.map((o) => `- ${o.id} · ${offerSeat(o)} · ${offerTerms(o)}`).join("\n")
        : `받은 제안 없음.`,
    ),
    block(
      "vacancies",
      vacancies.length > 0
        ? lines(`경질 뒤 ${VACANCY_KNOCK_DAYS}일 안:`, ...vacancyRows(state))
        : null,
    ),
    /**
     * 무직에게도 신문은 온다 — **벤치가 비었다는 소식이 지금 가장 큰 사실이다**
     * (people.md §4-1). 공석 명부는 두드릴 문의 목록이고, 이쪽은 그 문이 왜 열렸나다.
     */
    block("media", mediaBlock(state)),
    block("time_passed", timePassedLine(state, passed)),
    block("recent", recent.length > 0 ? recent.map((r) => `- ${r}`).join("\n") : null),
    `</snapshot>`,
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
}

/**
 * 우리 팀 은퇴 — **이번 오프시즌의 명부 줄**만이다 (season.md §6). 전환이 은퇴를 다음
 * 시즌 프리시즌 시작일로 남기므로 날짜가 그 하루와 같은 줄이 방금 끝난 시즌의 은퇴다.
 *
 * ⚠️ **원장(`TRANSFER`)이 아니라 명부(`state.retired`)를 읽는다.** 은퇴하면 선수는
 * `state.players`에서 빠져 원장 줄의 id로는 이름도 나이도 되찾지 못한다 — 명부가
 * 서기 전에는 이 블록이 아무 줄도 내지 못했다.
 */
function retirementFacts(state: GameState): string[] {
  return (state.retired ?? [])
    .filter((r) => r.teamId === state.userTeamId && r.on === state.calendar.preseasonStart)
    .map((r) => {
      // 우리 팀에서의 기록 — 통산 접기는 한 곳이다(`careerTotalsOf`). 여기서 다시
      // 합하면 화면·선수 카드가 내는 수와 은퇴 줄의 수가 언젠가 갈린다
      const ours = careerTotalsOf(state, r.gamePlayerId, state.userTeamId);
      return `은퇴: ${r.name} ${ageOf(r.birthdate, r.on)}세 · 우리 팀에서 ${ours.apps}경기 ${ours.goals}골`;
    });
}

/**
 * **아직 답하지 않은 유스 후보** — 이번 여름의 인테이크 (season.md §6).
 *
 * 물음표도 평가어도 없는 장부 줄이다. 인테이크 데이를 어떤 자리로 열지, 누구를 아깝다고
 * 말할지는 GM이 정한다.
 *
 * ⚠️ **후보에게는 안개가 낀다 — `adapting` 눈금이다** (player.md §9). 계약서에 사인하기
 * 전이라 훈련장에서 본 것이 전부이고, 그래서 종합도 잠재력도 참값이 아니라 관측값으로
 * 선다. 코어는 참값으로 계산하고 여기 서는 것은 감독이 그렇게 알고 있는 값이다.
 */
function youthCandidateFacts(state: GameState): string[] {
  const rows = ourYouthCandidates(state);
  if (rows.length === 0) return [];
  const lines = rows.map((row) => {
    const { overall, potential } = youthCandidateFog(state.seed, row.player);
    const age = ageOf(row.player.birthdate, state.date);
    return (
      `유스 후보: ${row.player.name} ${age}세 · ${naturalPositionOf(row.player).position} · ` +
      `종합 ~${overall} · 잠재력 ${potential.low}~${potential.high}(${potential.confidence}) · ` +
      `주급 ${formatMoney(row.weeklyWage)}/주 · ${row.years}년` +
      (row.autoSign ? " · 답이 없으면 구단이 계약한다" : "")
    );
  });
  const auto = rows.filter((row) => row.autoSign).length;
  lines.push(
    `유스 인테이크 기한: ${youthIntakeDeadline(state)} (선수단 소집일) — ` +
      `그때까지 답이 없으면 위 ${auto}명이 계약하고 나머지는 돌아간다`,
  );
  return lines;
}

/**
 * 방금 끝난 시즌의 시상 중 **감독에게 가는 것** — 우리 리그의 상과 컵·대항전의 상
 * 전부다(`awardReachesManager` — season.md §6). 우리 선수든 남의 선수든 함께 싣고,
 * 어느 쪽인가는 팀 이름이 말한다.
 *
 * 거르는 문도 줄도 코어가 이미 갖고 있는 것을 쓴다(`awardReachesManager`·
 * `awardLine` — 시즌 리뷰의 다이제스트가 쓰는 그 문과 그 줄이다). 여기서 다시
 * 쓰면 같은 상이 다이제스트와 스냅샷에서 다른 문장으로, 또는 한쪽에만 선다.
 */
function awardFacts(state: GameState): string[] {
  return (state.awards ?? [])
    .filter((a) => a.season === state.season - 1 && awardReachesManager(state, a))
    .map((a) => awardLine(a));
}

/**
 * 방금 끝난 시즌이 세운 **구단 기록** — 시즌 리뷰가 다이제스트에 낸 그 카드다
 * (season.md §6 기록 경신). 다이제스트는 시즌이 넘어간 그 한 턴에만 서므로, 오프시즌
 * 내내 읽히는 이 자리에도 같은 사실이 서야 한다 — 시상과 같은 결이다.
 *
 * ⚠️ **판정도 줄도 코어의 것을 그대로 쓴다**(`recordBreaksOf`·`recordBreakLine`).
 * 견주는 대상은 **그 시즌 앞의 시즌들**인데 결산 스냅샷은 이미 남은 뒤라, 그 시즌을
 * 뺀 장부를 건넨다 — 그러지 않으면 자기 자신과 견줘 아무것도 경신이 아니게 된다.
 */
function recordFacts(state: GameState): string[] {
  const teamId = managedTeamId(state);
  if (teamId === null) return [];
  const last = state.season - 1;
  const snapshot = (state.history ?? []).find((h) => h.season === last && h.teamId === teamId);
  const league = snapshot?.leagues.find((l) => l.rows.some((r) => r.teamId === teamId));
  if (!league) return [];
  const index = league.rows.findIndex((r) => r.teamId === teamId);
  const record = league.rows[index]?.record;
  // 이관된 행은 승점도 득점도 모른다 — 없는 수로는 무엇도 경신할 수 없다
  if (record === undefined) return [];
  const before = { ...state, history: (state.history ?? []).filter((h) => h.season < last) };
  return recordBreaksOf(before, teamId, {
    season: last,
    leagueId: league.leagueId,
    points: record.points,
    goalsFor: record.goalsFor,
    position: index + 1,
  }).map(recordBreakLine);
}

/**
 * 오프시즌 사실 블록 — **선수단 소집 전에만** 선다 (season.md §6 오프시즌).
 * 소집일이 지나면 사라진다: 오프시즌의 자리는 오프시즌에 있다.
 *
 * 전환은 `season++` 뒤 다음 시즌 7월 1일로 건너뛰므로, 여기 서는 시상은 지금
 * 시즌이 아니라 **방금 끝난 시즌**(`state.season - 1`)의 것이다.
 *
 * ⚠️ 물음표도 평가어도 없는 장부 줄이다 — 회견의 `PressFact`와 같은 결이다
 * (people.md §4). 코어는 사실만 낸다: 은퇴식을 어떻게 열지, 상을 누가 어떤 말로
 * 전할지는 GM의 몫이다. 사실이 하나도 없으면 블록을 세우지 않는다.
 */
function offseasonFacts(state: GameState): string | null {
  if (!onSummerBreak(state.calendar, state.date)) return null;
  const facts = [
    ...recordFacts(state),
    ...retirementFacts(state),
    ...awardFacts(state),
    ...youthCandidateFacts(state),
  ];
  if (facts.length === 0) return null;
  return `지난 시즌이 닫히며 남은 것 — 자리를 어떻게 열지, 누가 무슨 말을 하는지는 네가 정한다:\n${facts
    .map((f) => `- ${f}`)
    .join("\n")}`;
}

/**
 * 회견 밖의 기사 — **이번 턴의 새 것만** (people.md §4-1 · agents.md §6).
 *
 * `<news>`와 같은 소비 규약이라 읽기만 하고 비우지 않는다 (`takeMedia`는 gm.ts).
 * 줄은 도메인이 만든다(`mediaFactText`) — 화면·스냅샷·테스트가 같은 자를 쓴다.
 */
function mediaBlock(state: GameState): string | null {
  const facts = state.media ?? [];
  if (facts.length === 0) return null;
  return facts.map((f) => `- ${f.date} · ${mediaFactText(f)}`).join("\n");
}

/**
 * 복귀 뒤 이 블록이 「방금 돌아왔다」로 치는 기간 (일) — 경기 다이제스트와 같은 결이다.
 * 그 며칠이 지나면 몸은 클럽의 사정이고, 남는 것은 선수 카드의 통산 줄이다.
 */
const CALL_UP_RETURN_DAYS = 3;

/**
 * 돌아온 몸 — 코드가 아니라 낱말로 (`CallUpReturnState`). 「지쳐서 돌아왔다」를
 * 어떻게 말할지는 GM이 쓴다.
 */
const CALL_UP_RETURN_KO: Record<CallUpReturnState, string> = {
  fit: "몸 이상 없음",
  tired: "피로 누적",
  injured: "부상",
};

/** 통산 A매치 조각 — 캡이 0이면 적지 않는다 (세계의 대다수가 그렇다) */
function capsPart(player: GamePlayer): string {
  const caps = capsOf(player.state);
  if (caps === 0) return "";
  const goals = internationalGoalsOf(player.state);
  return ` · 통산 ${caps}캡${goals > 0 ? ` ${goals}골` : ""}`;
}

/** 협회 한 칸 — 코드와 표기를 함께. 코드만 실으면 모델이 `KVX`를 읽고 말을 지어낸다 */
const associationPart = (code: string): string => `${associationName(code)}(${code})`;

/**
 * **A매치 휴식기 블록** — 우리 선수가 클럽을 떠나 있거나 방금 돌아온 동안만 선다
 * (→ docs/data/competition.md §5-1).
 *
 * 이 덩어리가 있는 이유는 하나다: **없으면 모델이 대표팀을 지어낸다.** 데뷔도
 * 캡 수도 프롬프트에 없으면 「드디어 첫 대표팀 데뷔」가 서른 살 주전에게 붙는다
 * (agents.md §6 · `scout_reports`와 같은 이유).
 *
 * ⚠️ 물음표도 권고도 없는 장부 줄이다 — 「로테이션을 고려하시죠」는 이 자리의 것이
 * 아니다. 근거가 되는 사실을 짚고 그 사실로 무슨 말을 할지는 GM이 쓴다
 * (overview.md §1 철칙 4 · `loanDigestLine`과 같은 계약).
 */
function internationalFacts(state: GameState): string | null {
  const players = userPlayers(state);
  const sections: string[] = [];

  // ── 지금 소집 중 — 그 열흘이 감독의 이번 주다
  const out = players.flatMap((player) => {
    const callUp = openCallUp(state, player.id);
    return callUp === null ? [] : [{ player, callUp }];
  });
  const openBreak = out[0]?.callUp.breakKey;
  if (openBreak !== undefined) {
    const window = internationalBreaksOf(state.season).find((w) => w.key === openBreak);
    const head =
      window === undefined
        ? "대표팀 소집 중"
        : `${window.label} — ${window.to} 복귀 (${Math.max(0, diffDays(state.date, window.to))}일 남음)`;
    sections.push(
      [
        head,
        ...out.map(
          ({ player, callUp }) =>
            `- ${player.name} ${associationPart(callUp.country)} 소집${callUp.debut === true ? " · 첫 소집" : ""}${capsPart(player)}`,
        ),
      ].join("\n"),
    );
  }

  // ── 여름 대회를 뛰고 아직 안 온 선수 — 프리시즌의 훈련장이 비어 있는 이유다
  const late = players.filter((p) => {
    const summer = p.state.summerReturn;
    return summer !== undefined && state.date < summer && openCallUp(state, p.id) === null;
  });
  if (late.length > 0) {
    sections.push(
      late
        .map(
          (p) =>
            `- ${p.name} 여름 대회로 아직 합류 전 — ${p.state.summerReturn} 합류${capsPart(p)}`,
        )
        .join("\n"),
    );
  }

  // ── 방금 돌아온 창 — 무엇을 하고 어떤 몸으로 왔나
  const closed = internationalBreaksOf(state.season).find(
    (w) => w.to <= state.date && diffDays(w.to, state.date) <= CALL_UP_RETURN_DAYS,
  );
  if (closed !== undefined) {
    const byId = new Map(players.map((p) => [p.id, p] as const));
    const back = callUpsOfBreak(state, closed.key).flatMap((c) => {
      const player = c.returnedOn === null ? undefined : byId.get(c.gamePlayerId);
      if (player === undefined) return [];
      // 첫 소집이어도 그 창에서 못 뛰었으면 데뷔가 아니다 — `debut`은 소집 시점의 캡이 0이었다는 표식이다
      const debut = c.debut === true && c.apps > 0 ? " · 대표팀 데뷔" : "";
      const played = c.apps > 0 ? `${c.apps}경기 ${c.goals}골` : "출전 없음";
      const body = c.returnState === undefined ? "" : ` · ${CALL_UP_RETURN_KO[c.returnState]}`;
      return [
        `- ${player.name} ${associationPart(c.country)} ${played}${debut}${body}${capsPart(player)}`,
      ];
    });
    if (back.length > 0) {
      sections.push([`${closed.label} 복귀 (${closed.to})`, ...back].join("\n"));
    }
  }

  if (sections.length === 0) return null;
  /**
   * **지금 부릴 수 있는 1군이 몇인가** — 감독이 그 주에 실제로 겪는 사실이다.
   * 코어의 문을 그대로 읽는다(`isAvailableFor`): 부상·정지·소집이 한 자리에서
   * 갈리고, **정지는 다음 경기의 대회로 묻는다** (match.md §6).
   */
  const nextCompetition =
    nextMatchFor(state.matches, state.userTeamId, state.date)?.competitionId ?? null;
  const firstTeam = players.filter((p) => squadLevelOf(p) === "first");
  sections.push(
    `지금 부릴 수 있는 1군 ${firstTeam.filter((p) => isAvailableFor(state, p, nextCompetition)).length}/${firstTeam.length}명`,
  );
  return sections.join("\n");
}

export function buildGmStateNote(
  state: GameState,
  passed?: TimePassed | null,
  /** 이번 턴에 카드로 서는 보고서 — 카드가 프롬프트에 못 가므로 값은 여기로 온다 */
  arrivedReports: readonly ScoutReportCard[] = [],
  /** 같은 자리의 임무 보고 — 지목과 한 블록을 나눠 쓴다 */
  arrivedMissions: readonly MissionReportCard[] = [],
): string {
  // 무직이면 실을 것이 다른 것들이다 (career.md §5.1)
  if (managedTeamId(state) === null) return buildUnemployedNote(state, passed);

  const standings = computeStandings(state);
  const rank = standings.findIndex((r) => r.teamId === state.userTeamId) + 1;
  // 0경기 순위는 싣지 않는다 — 정렬 순서일 뿐인데 모델이 구단의 처지로 읽는다
  const played = standings.find((r) => r.teamId === state.userTeamId)?.played ?? 0;
  const tac = tacticsOf(state, state.userTeamId).spec;
  const finance = financeOf(state, state.userTeamId);
  const players = userPlayers(state);

  const injured = players
    .map((p) => {
      const inj = openInjury(state, p.id);
      return inj ? `${p.name} ${inj.bodyPart}~${inj.expectedReturn}` : null;
    })
    .filter((x): x is string => x !== null);
  /**
   * **정지는 어느 대회의 것인지까지 싣는다** (match.md §6) — 컵 정지 선수는 다음
   * 리그 경기에 서므로, 대회 없는 이름은 GM에게 잘못된 결장자를 준다.
   */
  const suspended = players
    .map((p) => {
      const ban = activeSuspension(state, p.id);
      return ban === null
        ? null
        : `${p.name} ${suspensionScopeName(ban)} ${ban.lengthMatches - ban.served}경기`;
    })
    .filter((x): x is string => x !== null);
  /**
   * **다치기 전에 서는 줄** (player.md §5.3) — 부상 줄은 이미 쓰러진 뒤의 사실이라,
   * 이것이 없으면 수석코치가 "쉬게 하시죠"라고 말할 근거가 어디에도 없다.
   * 지금 뛸 수 있는 **1군**만 센다 — 다친 선수의 이력은 감독이 손쓸 일이 아니고,
   * 2군의 몸은 이번 주 라인업의 사정이 아니다 (수석코치의 눈도 같은 문이다).
   *
   * ⚠️ **등급이 아니라 이력이 간다.** 「위험 높음」은 코어의 판단이고, 이 줄이 하는
   * 일은 모델이 판단할 **재료**를 주는 것이다 — 두 시즌의 건수·결장 일수·최근 부상을
   * 주면 「최근에 돌아온 주전」과 「늘 삐끗하는 백업」을 모델이 갈라 말한다. 코어가
   * 셋을 한 낱말로 접으면 그 갈림이 프롬프트에 닿지 못한다 (overview.md §1 철칙 4).
   */
  const atRisk = players
    .filter((p) => squadLevelOf(p) === "first" && !isInjured(state, p.id))
    .flatMap((p) => {
      const line = injuryHistoryText(injuryHistoryOf(state, p.id));
      return line === null ? [] : [`${p.name} — ${line}`];
    });
  /**
   * **시즌이 몸에 쌓아 둔 것** (player.md §5.5) — 위험 줄과 **다른 줄인 이유는 감독이
   * 쥐는 손잡이가 다르기 때문이다.** 위험은 이번 경기의 라인업으로 답하고 과부하는
   * 몇 주의 로테이션·개인 휴식으로 답한다. 한 줄로 접으면 GM이 "오늘 빼시죠"만
   * 말하게 되고, 잔고는 그것으로 빠지지 않는다.
   */
  const overloaded = players
    .filter(
      (p) =>
        squadLevelOf(p) === "first" &&
        !isInjured(state, p.id) &&
        fatigueBand(fatigueOf(p.state)) === "overloaded",
    )
    .map((p) => p.name);
  const unhappy = state.issues.map((i) => playerName(state, i.gamePlayerId));

  const training = upcomingTrainingLines(state);
  const trainingCount = state.schedule.filter(
    (e) => e.type === "training" && e.status === "scheduled" && e.date >= state.date,
  ).length;

  const alerts = [
    // 판정 대기 협상이 맨 앞 — 답은 다음 턴 입력에 실리므로 여기서 세우지 않으면 잊힌다
    ...pendingVerdicts(state).map((v) => `❗ ${v.label} (${v.negotiation.id})`),
    /**
     * 감독이 아직 답하지 않은 이적 요청 — 기한이 없어 저절로 사라지지 않는다
     * (transfer.md §1-1). 우리 선수의 것만 센다 — 떠난 선수의 줄이 섞이면 남의
     * 선수가 감독이 답해야 할 일로 주의 줄에 유령처럼 선다.
     */
    (() => {
      const ours = new Set(players.map((p) => p.id));
      const requests = openTransferRequests(state).filter((r) => ours.has(r.gamePlayerId));
      return requests.length > 0
        ? `❗ 이적 요청 ${requests.length} (${requests
            .slice(0, TRANSFER_REQUEST_SHOWN)
            .map(
              (r) => `${playerName(state, r.gamePlayerId)} ${TRANSFER_REQUEST_REASON_KO[r.reason]}`,
            )
            .join(", ")}${requests.length > TRANSFER_REQUEST_SHOWN ? " …" : ""})`
        : null;
    })(),
    suspended.length > 0 ? `정지 ${suspended.length} (${suspended.join(", ")})` : null,
    unhappy.length > 0 ? `불만 ${unhappy.length} (${unhappy.join(", ")})` : null,
    /**
     * 만료 임박 계약 — 재계약 서사의 씨앗. 놓치면 자유계약으로 떠난다.
     *
     * **이미 다른 구단과 사전 계약을 맺은 선수는 이 줄에서 빠진다**
     * (→ docs/simulation/transfer.md §1-4). 그는 재계약을 열 수 있는 사람이 아니라
     * 떠나기로 한 사람이라, 같은 줄에 세우면 GM이 매 턴 감독에게 없는 손잡이를
     * 권한다. 아래 별도의 줄이 그 사실을 든다.
     */
    (() => {
      const expiring = expiringContracts(state, EXPIRING_ALERT_DAYS).filter(
        (row) => pendingContractOf(state, row.player.id) === null,
      );
      return expiring.length > 0
        ? `계약 만료 임박 ${expiring.length} (${expiring
            .slice(0, EXPIRING_SHOWN)
            .map((row) => `${row.player.name}~${row.contract.until}`)
            .join(", ")}${expiring.length > EXPIRING_SHOWN ? " …" : ""})`
        : null;
    })(),
    /**
     * **떠나기로 한 선수** — 다른 구단과 사전 계약을 맺어 발효일에 나갈 사람들
     * (transfer.md §1-4). 감독이 할 수 있는 일은 없지만 스쿼드 계획의 사실이라,
     * 이 줄이 없으면 GM은 여름에 사라질 주전을 이번 시즌 내내 붙박이로 말한다.
     */
    (() => {
      const leaving = userPlayers(state).flatMap((player) => {
        const pending = pendingContractOf(state, player.id);
        return pending ? [{ player, pending }] : [];
      });
      return leaving.length > 0
        ? `사전 계약으로 떠남 ${leaving.length} (${leaving
            .slice(0, PRECONTRACTED_SHOWN)
            .map((row) => `${row.player.name}→${teamName(row.pending.teamId)} ${row.pending.since}`)
            .join(", ")}${leaving.length > PRECONTRACTED_SHOWN ? " …" : ""})`
        : null;
    })(),
    /**
     * 기한이 다가온 약속 — **감독이 아직 지킬 수 있는 동안만** 선다 (people.md §5-2).
     * 판정은 기한 하루뿐이라, 이 줄이 없으면 감독이 자기가 한 말을 잊은 채 그날을
     * 지나치고 사기 −8과 불만 하나를 받는다.
     */
    (() => {
      const due = openPromises(state)
        .filter((p) => diffDays(state.date, p.dueOn) <= PROMISE_ALERT_DAYS)
        .sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0));
      return due.length > 0
        ? `약속 기한 임박 ${due.length} (${due
            .slice(0, PROMISE_SHOWN)
            .map(
              (p) => `${playerName(state, p.gamePlayerId)} ${PROMISE_KIND_KO[p.kind]}~${p.dueOn}`,
            )
            .join(", ")}${due.length > PROMISE_SHOWN ? " …" : ""})`
        : null;
    })(),
  ].filter((x): x is string => x !== null);

  /**
   * **몸의 사실 — 의료진의 것이다** (people.md §3 화자 표). 주의 줄에 뭉쳐 있던
   * 셋이 화자를 얻어 나온 자리다. 사실은 한 글자도 달라지지 않는다: 달라지는 것은
   * 이 사실이 프롬프트에서 누구의 것으로 서는가뿐이다.
   */
  const medical = [
    injured.length > 0 ? `부상 ${injured.length} (${injured.join(", ")})` : null,
    atRisk.length > 0
      ? `부상 이력 ${atRisk.length} (${atRisk.slice(0, AT_RISK_SHOWN).join(" / ")}${
          atRisk.length > AT_RISK_SHOWN ? " …" : ""
        })`
      : null,
    overloaded.length > 0
      ? `과부하 ${overloaded.length} (${overloaded.slice(0, OVERLOADED_SHOWN).join(", ")}${
          overloaded.length > OVERLOADED_SHOWN ? " …" : ""
        })`
      : null,
  ].filter((x): x is string => x !== null);

  // 스카우팅 진행과 도착한 보고서는 **같은 사람의 것이다** — 덩어리 둘의 이름이 하나다
  const scout = factSpeakerOf(state, "scouting");

  const cues = speakerCues(state);
  const coach = coachCues(state);
  const offseason = offseasonFacts(state);
  const international = internationalFacts(state);
  const negotiations = describeNegotiations(state);
  const recent = recentNarrativeLines(state);
  const edits = state.pendingEdits ?? [];
  const news = state.pendingNews ?? [];

  return [
    `<snapshot>`,
    block(
      "now",
      lines(
        `${state.date} (${DOW_KO[dayOfWeek(state.date)]}) ${formatClock(clockOf(state))} · 시즌 ${state.season}${
          played > 0 && rank > 0 ? ` · 리그 ${rank}위` : ""
        } · ${describeWindowState(state)}`,
        describeNextFixture(state),
        // 부임 직후엔 선수단이 여름 휴가 중 — 소집일을 밝혀야 빈 훈련장을 지어내지 않는다
        state.date < squadReturnOf(state.calendar)
          ? `선수단 여름 휴가 중 — ${squadReturnOf(state.calendar)} 소집`
          : trainingCount > 0
            ? `예정 훈련 ${trainingCount}건: ${training.join(" / ")}${trainingCount > training.length ? " …" : ""}`
            : `예정 훈련 없음 — 기본 훈련까지 비워진 상태다`,
      ),
    ),
    block(
      "club",
      lines(
        // 6축 슬라이더는 싣지 않는다 — 화자가 입에 담지 않는 수치이고 `get_squad`가
        // 배치와 함께 낸다. 모양과 적응도는 코치의 말에 그대로 실린다
        `전술: ${tac.formation} · 선발 평균 적응 ${familiarityLabel(squadFamiliarity(state, state.userTeamId))}`,
        `재정: 잔고 ${formatMoney(finance.balance)} · 주급 ${formatMoney(weeklyWagesOf(state, state.userTeamId))}/주 · 이적예산 ${formatMoney(finance.transferBudget)}`,
        /**
         * **구단주가 건 다년 계획** (career.md §5) — 시즌 끝에 묻는 것이 순위 한 칸이
         * 아니라는 사실이 여기 실려야 국부펀드형과 지역 유지형이 다르게 말한다.
         * 시즌에 한 번 바뀌는 값이라 이 층에서도 안정적이다.
         */
        (() => {
          const vision = visionOf(state);
          // 0경기 순위는 팀 id 정렬일 뿐이다 — 아직 자리가 없으면 코어에 0을 넘긴다
          const seat = { position: played > 0 ? rank : 0, leagueSize: standings.length };
          const items = visionReadings(state, seat).map(visionItemText);
          return (
            `구단 비전 ${visionYearOf(vision, state.season)}년차/${visionSpanOf(vision)}년 계획: ` +
            items.join(" · ")
          );
        })(),
        /**
         * 선수단 — **이름 명단이다. 이름뿐이다.** "누가 우리 팀인가"는 매 장면의 전제라
         * 입력에 없으면 GM이 없는 선수를 세우고, 명단은 영입·승격마다 바뀌어 캐시 층에
         * 둘 수도 없다. 그래서 캐시가 걸리지 않는 이 층이 이름을 진다.
         *
         * 능력치·컨디션·계약·배치는 따라오지 않는다 — 그것까지 실으면 이 층의 절반을
         * 먹고, 그 값은 조회가 이미 낸다 (agents.md §5·§7 · prompts.md §5-2).
         * ⚠️ 도구 이름을 적지 않는다 — 데이터 블록에는 사실만 (prompts.md §5-3).
         */
        (() => {
          // 구분자는 쉼표가 아니라 가운뎃점이다 — 한국어 성명에 공백이 들어가서
          // 쉼표로 이으면 어디서 한 사람이 끝나는지가 흐려진다
          const named = (level: "first" | "reserve") =>
            players
              .filter((p) => squadLevelOf(p) === level)
              .map(
                (p) =>
                  `${p.name}${p.isCaptain ? "(주장)" : p.isViceCaptain === true ? "(부주장)" : ""}`,
              );
          const first = named("first");
          const reserve = named("reserve");
          /**
           * 임대 보낸 선수는 **합계에 들지 않고 따로 선다.** 1군 + 2군이 곧 오늘
           * 부릴 수 있는 인원이라, 합계에 넣으면 GM이 남의 경기장에 있는 사람을
           * 오늘의 선택지로 센다. 계약은 우리 것이므로 명단에서 지우지도 않는다
           * (transfer.md §2 · season.md §2 임대).
           *
           * ⚠️ 여기도 **이름뿐이다** — 어느 구단에 가 있는지도, 그 구단에서의
           * 기록도 싣지 않는다. 그건 코치 카드와 조회의 몫이다.
           */
          const loaned = loanedOut(state).map((p) => p.name);
          return lines(
            `선수단 ${players.length}명`,
            first.length > 0 ? `- 1군 ${first.length}: ${first.join(" · ")}` : null,
            reserve.length > 0 ? `- 2군 ${reserve.length}: ${reserve.join(" · ")}` : null,
            loaned.length > 0 ? `- 임대 ${loaned.length}: ${loaned.join(" · ")}` : null,
          );
        })(),
      ),
    ),
    block(
      "manager",
      lines(
        // 감독의 능력·평판은 캐시 밖이다 — 평판은 경기마다 움직이고 능력도 자란다.
        // 레퍼런스(감독 프로필)엔 이름·배경만 남는다
        `${state.manager.name}: ${describeManagerSkills(state.manager.attributes)}`,
        `평판: ${describeReputation(state.manager.reputation)}`,
        /**
         * 보드가 이번 시즌 이 구단에 건 기대 (career.md §5). 시즌에 한 번 바뀌는 값이지만
         * 캐시 층에 두면 롤오버 한 번에 레퍼런스와 그 뒤 이력이 통째로 무효가 된다.
         *
         * 경고 수(`boardWarnings`)는 따라오지 않는다 — 압박을 세는 눈금은 `get_career`의
         * 몫이고, 여기 필요한 것은 그 눈금이 무엇을 재는지다.
         */
        (() => {
          const be = boardExpectation(state, state.userTeamId);
          return boardExpectationLine(be.code, be.target);
        })(),
        // 감독 자신의 계약 — 연봉·만료일과 보드의 재계약 판정 (career.md §5.4)
        managerContractLine(state),
        /**
         * 그 아래가 감독의 거취다 — 열린 제안(재계약·접근·노크)과 두드릴 수 있는
         * 공석 (career.md §5.1). 계약 줄과 **같은 자리**인 것은 셋 다 감독 자신의
         * 일이기 때문이다.
         */
        ...managerSeatLines(state),
      ),
    ),
    // 한 줄에 하나 — 이어 붙이면 일곱 항목이 가운뎃점 사이에 묻힌다
    block("alerts", alerts.join("\n")),
    // 부상·부상 이력·과부하 — 의무실을 맡은 사람의 것. 자리가 비면 수석코치가 선다
    block("medical", medical.join("\n"), ` name="${factSpeakerOf(state, "medical").name}"`),
    // 파견 중인 스카우트 — 도착한 보고서(<scout_reports>)와 같은 사람의 덩어리다
    block("scouting", scoutingSummary(state).join("\n"), ` name="${scout.name}"`),
    // 선수 근황 — 선수단 중 **사실이 붙는** 셋이다.
    // 코어는 사실만 낸다(speakerCues) — 누가 말할지, 무슨 말을 할지는 GM의 몫
    block("cues", cues.map((c) => `- ${c.name} ${c.fact}`).join("\n")),
    /**
     * 코치가 먼저 짚는 사실 — **원형이 고른다** (people.md §7-1). 근황과 같은
     * 결이되 고르는 눈이 다르다: 분석가는 상대의 표를, 조련사는 다리를 먼저 본다.
     * 여기도 사실뿐이고(`coachCues`) 그 사실로 무슨 말을 할지는 GM이 쓴다.
     * 무직이면 코어가 빈손을 내므로 이 덩어리는 서지 않는다.
     *
     * 화자가 둘일 수 있다 — 훈련장·2군·임대는 그 자리를 맡은 코치의 것이라 같은 태그가
     * 이름만 달리해 한 번 더 선다 (people.md §3 화자 표).
     */
    ...coachBlocks(state, coach),
    /**
     * 경기 전날·당일의 상대 분석 — 감독이 라인업과 6축을 정하는 자리다.
     * 조회 도구·다음 경기 카드와 **같은 리포트**를 읽는다 (match.md §1.8).
     */
    opponentBlock(state),
    block("last_match", matchDigest(state)),
    // 오프시즌 — 은퇴와 시상. 소집 전에만 서고, 없으면 한 줄도 쓰지 않는다
    block("offseason", offseason),
    // A매치 휴식기 — 누가 클럽을 떠나 있고 무엇을 하고 돌아왔나. 오프시즌 옆인 이유가
    // 같은 결이어서다: 둘 다 「시즌의 이 시기가 무엇인가」를 말한다
    block("international", international),
    // 그 사이 벌어진 일 — 손잡이로 시간을 넘긴 턴에만. 없으면 모델이 넘긴 구간의
    // 일(부상·오퍼)을 모른 채 장면을 쓴다
    block("time_passed", timePassedLine(state, passed)),
    /**
     * 도착한 스카우트 보고서 — **이번 턴에 화면 카드로 서는 그것들이다.**
     *
     * 카드는 모델이 장면을 쓴 뒤에 붙어 프롬프트에 가지 않는다. 그래서 값이 여기
     * 없으면 모델은 카드 옆에서 금액을 지어내고, 한 화면이 두 말을 한다
     * (agents.md §6). 줄은 카드와 같은 함수에서 나온다 — `scoutReportLine`.
     *
     * **임무 보고도 여기 선다** — 지목의 줄 다음에 후보 다섯이 잇는다
     * (`missionReportLine`). 이 블록이 답하는 물음은 「이번 턴에 카드로 서는 것의
     * 값」이고 두 갈래가 같은 물음이다.
     */
    block(
      "scout_reports",
      [
        ...arrivedReports.map((c) => `- ${scoutReportLine(state, c.playerId) ?? c.name}`),
        ...arrivedMissions.map((m) => `- ${missionReportLine(state, m.missionId) ?? m.brief}`),
      ].join("\n"),
      ` name="${scout.name}"`,
    ),
    /**
     * 경기 뒤 들어온 소식 — 재정과 같은 라운드의 다른 경기·대진.
     *
     * 알림(대회 말풍선)에는 싣지 않는 갈래다(화면이 이미 갖고 있다). 그래도 모델은
     * 알아야 한다 — 순위가 뒤집힌 걸 모른 채 다음 장면을 쓰면 세계가 감독의 경기
     * 하나로 멈춘 것처럼 읽힌다. 읽기만 하고 비우지 않는다 (`takeNews`는 gm.ts).
     */
    block("news", news.map((n) => `- ${n}`).join("\n")),
    /**
     * 회견 밖에서 언론이 쓴 것 — 시즌 예상·펀딧 평가·경질과 부임 (people.md §4-1).
     * 감독이 답하는 자리가 아니라 배경이라 `<news>` 옆에 선다.
     */
    block("media", mediaBlock(state)),
    // 채팅 턴 없는 화면 조작(전술판·명단·역할) — 이미 반영된 사실이라 모델은 반응만 한다
    block("edits", edits.map((e) => `- ${e.text}`).join("\n")),
    // 답을 기다리는 기자회견 — 이 덩어리가 없으면 모델은 회견이 열린 사실 자체를 모른다
    pressBlock(state),
    // 감독을 찾아온 사람 — 세계가 먼저 연 자리다 (people.md §8). 회견과 함께 서지 않는다
    approachBlock(state),
    /**
     * 감독이 보드에 건 요청 — 답을 기다리는 것·공사 중인 구장·열려 있는 주급 상향
     * (finance.md §9.6). 답이 도착한 날은 `<time_passed>`가 나른다.
     */
    block("board", describeBoardRequests(state)),
    /**
     * 오퍼 앞에 서 있는 관심 — 우리 선수를 보는 구단과, 우리가 노리는 선수에게
     * 붙은 경쟁 구단 (transfer.md §1-2).
     *
     * 협상 블록보다 앞에 서는 이유가 시간 순서다: 이 사실이 없으면 모델은 오퍼가
     * 열린 날에야 그 구단의 이름을 처음 듣는다. 그러면 회견의 질문도, 라커룸의
     * 수군거림도, 재계약 테이블의 압박도 설 자리가 없다 — 소문은 오퍼 앞에서만
     * 장면이 된다. 관심이 없으면 덩어리도 서지 않는다.
     */
    block("interest", describeInterests(state).join("\n")),
    // 협상은 있을 때만 — 매 턴 정가로 읽히는 블록이다
    block("negotiations", negotiations.startsWith("진행 중인 협상 없음") ? null : negotiations),
    // 쓸 수 있는 되사기 권리 — 이 덩어리가 없으면 모델은 그 자리가 있는 줄도 모른다
    block("buybacks", describeBuyBackRights(state)),
    // 활성 서사 아크 — 닫힐 때까지 매 턴 실려 GM이 시즌을 가로지르는 흐름을 잃지 않는다
    // (people.md §9). 개폐도 사실 줄도 코어의 것이다
    block("arcs", describeActiveArcs(state)),
    /**
     * 시작 사건 — 부임 첫 몇 주의 실마리. 아크와 같이 **개폐가 코어의 것**이라 여기
     * 실리는 것은 아직 열린 줄뿐이다: 감독이 그 실마리에 걸린 일을 하면 다음 턴에
     * 빠지고, 아무도 손대지 않은 것만 기한까지 선다 (career.md §1).
     */
    block("openings", describeOpenings(state)),
    block("recent", recent.map((r) => `- ${r}`).join("\n")),
    `</snapshot>`,
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
}

/** 해석기가 읽는 지난 턴 수 — 이름 없는 지목이 가리키는 대상은 직전 대화에 있다 */
export const RECENT_TURNS = 5;
/** 지난 턴 본문 하나의 상한 — 해석에 필요한 것은 누가 무슨 말을 했는가지 장면 전부가 아니다 */
const RECENT_TURN_CHARS = 1200;

/**
 * 턴 목록을 해석기가 읽는 줄로 — **평시의 `<recent_turns>`와 경기의 `<match_log>`가 같은
 * 함수를 쓴다.** 감독 턴은 `@감독:` 봉투, 손잡이 턴은 오퍼레이터 봉투, 모델 턴은 본문을
 * 잘라서. 두 벌이면 한쪽만 고쳐져 두 해석기가 다른 말을 읽는다.
 */
export function renderTurns(turns: readonly ChatTurn[]): string[] {
  return turns.map((t) => {
    if (t.role === "user") return `@감독: ${t.text}`;
    if (t.role === "operator") return buildOperatorMessage(t.text);
    return t.text.slice(0, RECENT_TURN_CHARS);
  });
}

/** `<recent_turns>`의 본문 — 평시의 지난 턴들 */
export function buildRecentTurnsBlock(state: GameState, count = RECENT_TURNS): string {
  return renderTurns(state.chat.filter((t) => t.inMatch !== true).slice(-count)).join("\n");
}

/**
 * `<standing>` — **지금 우리가 걸어 둔 것 전부**: 6축과 갈래·세트피스 인원·지역 전술·
 * 개인 지시와 역할·완장·세트피스 키커. 경기 장부 노트와 평시의 지시 해석이 같은 블록을
 * 읽는다 — 두 벌이면 "압박 올려"의 지금 값이 한쪽에서 지어내진다 (agents.md §1).
 */
export function buildStandingBlock(
  state: GameState,
  regionalPlans?: NonNullable<GameState["pendingMatch"]>["regionalPlans"],
): string[] {
  const squad = playersOf(state, state.userTeamId);
  const captain = squad.find((p) => p.isCaptain);
  const vice = squad.find((p) => p.isViceCaptain === true);
  const takers = tacticsOf(state, state.userTeamId).setPieceTakers ?? {};
  const takerName = (id: string | undefined): string => (id ? playerName(state, id) : "지정 없음");
  /**
   * **지금 내가 무엇을 걸어 뒀는가** — 경기 중에는 평시 스냅샷(6축이 적힌 줄)이
   * 실리지 않아 여기가 유일한 자리다. 없으면 "압박 올려"에 지금 값이 지어내진다.
   */
  const ourTeamTactics = tacticsOf(state, state.userTeamId);
  const ourTactics = ourTeamTactics.spec;
  const assignments = ourTeamTactics.assignments.filter(
    (a) => a.role === "starting" && (a.directive || a.instruction || a.roleId),
  );
  /**
   * 걸어 둔 갈래 — **중립인 것은 세우지 않는다** (`tacticsBrief`와 같은 규칙).
   * 낱말은 `TACTIC_TOGGLES` 하나에서 온다 — 손으로 적으면 해석 프롬프트가 가르치는
   * 낱말과 이 줄이 갈린다 (prompts.md §5-2).
   */
  const ourToggles = TACTIC_TOGGLES.flatMap((toggle) => {
    const value = tacticToggleValue(ourTactics, toggle.key);
    return value === null ? [] : [`${toggle.brief} ${tacticToggleWord(toggle.key, value)}`];
  });
  /**
   * 걸어 둔 세트피스 지시 — 갈래와 **같은 규칙으로 중립은 서지 않는다.** 이 줄이
   * 없으면 걸어 둔 축이 「지금 걸어 둔 것」 목록에서 빠져, 인원을 올려 둔 판을 두고
   * 모델이 세트피스는 손대지 않았다고 답한다 (match.md §2).
   */
  const ourRoutine = SET_PIECE_ROUTINE_AXES.flatMap((axis) => {
    const level = setPieceRoutineLevel(ourTeamTactics.setPieceRoutine, axis.key);
    return level === SET_PIECE_ROUTINE_NEUTRAL
      ? []
      : [`${axis.label} ${setPieceRoutineWord(axis.key, level)}`];
  });
  return [
    `<standing>`,
    `전술 ${ourTactics.formation} · 멘탈${ourTactics.mentality} 라인${ourTactics.defensiveLine} ` +
      `압박${ourTactics.pressing} 템포${ourTactics.tempo} 폭${ourTactics.width} 패스${ourTactics.passStyle}` +
      (ourToggles.length > 0 ? ` · ${ourToggles.join(" · ")}` : ``) +
      (ourRoutine.length > 0 ? ` · ${SET_PIECE_KO} ${ourRoutine.join(" · ")}` : ``),
    regionalPlans && regionalPlans.length > 0
      ? `지역 전술: ${regionalPlans
          .map((r) => `${r.band}/${r.lane} ${r.intent} "${r.note}"`)
          .join(" · ")} (동시에 2곳까지 — 셋째를 걸면 가장 오래된 것이 밀린다)`
      : `지역 전술: 없음`,
    assignments.length > 0
      ? `개인 지시·역할: ${assignments
          .map(
            (a) =>
              `${playerName(state, a.playerId)}(${a.position}` +
              `${a.roleId ? ` ${a.roleId}` : ""}` +
              `${a.directive ? ` [${a.directive.kind}]` : ""}` +
              `${a.instruction && !a.directive ? ` "말로만: ${a.instruction}"` : ""})`,
          )
          .join(", ")}`
      : `개인 지시·역할: 없음`,
    `주장: ${captain ? playerName(state, captain.id) : "없음"} · 부주장: ${vice ? playerName(state, vice.id) : "없음"}`,
    `세트피스 키커: 코너 ${takerName(takers.corner)} · 프리킥 ${takerName(takers.freeKick)} · 페널티 ${takerName(takers.penalty)}`,
    `</standing>`,
  ];
}

/**
 * 경기 장부 + 현재 판세 — 매 턴 갱신되는 휘발성 블록. 패킷도 여기(캐시 밖)에
 * 담되 JSON을 통째로 붓지 않고 읽는 쪽이 실제로 쓰는 것만 요약한다.
 *
 * 읽는 쪽이 둘이라 `withPacket`이 세 갈래다.
 * - `true` — 중계가 판을 읽는 턴. 판세와 공략 표적을 함께 싣는다.
 * - `false` — 킥오프·대화만 건 턴. 아직 아무 일도 일어나지 않았는데 판세를 쥐여 주면
 *   첫 마디부터 우열을 읊는다. 그때 필요한 것은 대진과 선발뿐이다.
 * - 생략 — 지시 해석기. 감독의 말을 갈래로 나누는 데 기대 득점·상성·소화율은 쓰이지
 *   않는다. 명단·6축·공략 표적만 읽는다 (`exploits`는 그 표적의 id로만 채워진다).
 */
export function buildLedgerNote(state: GameState, options: { withPacket?: boolean } = {}): string {
  const pending = state.pendingMatch;
  const ledger = pending?.ledger;
  if (!ledger || !pending) return "";
  const packet =
    options.withPacket === true && pending.packet ? normalizePacket(pending.packet) : null;
  /** 태그가 이름을 대는 자리 — 표적 목록은 패킷이 없는 턴에도 선다 */
  const tagCtx = pending.packet ? packetTagContext(normalizePacket(pending.packet)) : undefined;
  /** 표적 목록은 판세와 갈린다 — 해석기는 수치 없이 이 목록만 읽는다 */
  const targets =
    options.withPacket === false
      ? []
      : pending.packet
        ? normalizePacket(pending.packet).targets
        : [];
  // 온필드 명단에 개인 전력(패킷의 effective)을 붙인다 — 존 평균만으론 "누가 안 도는가"가 안 보인다
  const effective = new Map(
    [...(packet?.home.lineup ?? []), ...(packet?.away.lineup ?? [])].map((p) => [p.id, p] as const),
  );
  /** 킥오프 턴엔 자리만 — 전력 수치는 패킷과 함께 다음 턴에 온다 */
  const position = new Map(
    [...(pending.packet?.home.lineup ?? []), ...(pending.packet?.away.lineup ?? [])].map(
      (p) => [p.id, p.position] as const,
    ),
  );
  const withNames = (ids: readonly string[] | undefined): string =>
    (ids ?? [])
      .map((id) => {
        const p = effective.get(id);
        if (p) return `${id}(${playerName(state, id)} ${p.position} ${p.effective})`;
        const at = position.get(id);
        return at ? `${id}(${playerName(state, id)} ${at})` : `${id}(${playerName(state, id)})`;
      })
      .join(", ");
  const packetLines = packet
    ? [
        ``,
        `<packet>`,
        // 판세를 읽는 것은 모델의 일이다 — 코어는 이름·수치·상성 근거만 싣는다
        `${packet.home.teamName}(홈) vs ${packet.away.teamName} — 기대 득점 ${packet.guide.expectedGoals.home} : ${packet.guide.expectedGoals.away}`,
        packet.matchups.map((m) => matchupText(m)).join(" / "),
        ...packet.keyPoints.map((k) => `· ${packetTagText(k, tagCtx)}`),
        `홈 전술 소화: ${Math.round(packet.home.tactical.uptake * 100)}%${
          packet.home.tactical.notes.length > 0
            ? ` — ${packet.home.tactical.notes.map((n) => packetTagText(n, tagCtx)).join(" / ")}`
            : ""
        }`,
        `어웨이 전술 소화: ${Math.round(packet.away.tactical.uptake * 100)}%${
          packet.away.tactical.notes.length > 0
            ? ` — ${packet.away.tactical.notes.map((n) => packetTagText(n, tagCtx)).join(" / ")}`
            : ""
        }`,
        `</packet>`,
      ]
    : [];
  // 공략 후보 — 노릴 수 있는 지점은 이 목록이 전부다 (없는 지점은 코어가 반려)
  const targetLines =
    targets.length > 0
      ? [
          // max — 동시에 노릴 수 있는 수. 고르는 쪽은 스키마의 maxItems로 읽고(prompts.md §2),
          // 넘겨 와도 코어가 자른다 (`setExploits`)
          `<targets max="${MAX_EXPLOITS}">`,
          ...targets.map((t) => `  ${t.id} — ${packetTagText(t.tag, tagCtx)}`),
          pending.exploits && pending.exploits.length > 0
            ? `지금 노리는 중: ${pending.exploits.join(", ")}`
            : `지금 노리는 곳 없음`,
          `</targets>`,
        ]
      : [];
  const standingLines = ["", ...buildStandingBlock(state, pending.regionalPlans)];
  // 사건은 싣지 않는다 — 코어가 이미 굴린 구간은 <segment>로 따로
  // 실린다. 이 블록은 그 구간이 끝난 자리의 장부다 (agents.md §3)
  /**
   * 교체 한도는 **국면이 정한다** — 연장은 6인/4회다 (match.md §5). 5/3으로 박아
   * 두면 연장에 들어간 모델이 아직 남은 카드를 없는 것으로 읽는다. 장부 검증과
   * AI 판단이 보는 것과 같은 함수다.
   */
  const subLimits = subLimitsOf(ledger.phase);
  return [
    `<ledger>`,
    `스코어 ${ledger.score.home}:${ledger.score.away} · ${ledger.minute}′ · ${ledger.phase}`,
    `홈 온필드: ${withNames(ledger.home.onPitch)}`,
    `홈 벤치: ${withNames(ledger.home.bench)} (교체 ${ledger.home.subsUsed}/${subLimits.maxSubs}, 기회 ${ledger.home.subWindows}/${subLimits.maxSubWindows})`,
    `어웨이 온필드: ${withNames(ledger.away.onPitch)}`,
    `어웨이 벤치: ${withNames(ledger.away.bench)} (교체 ${ledger.away.subsUsed}/${subLimits.maxSubs}, 기회 ${ledger.away.subWindows}/${subLimits.maxSubWindows})`,
    ledger.sentOff.length > 0 ? `퇴장: ${withNames(ledger.sentOff)}` : "",
    `</ledger>`,
    ...standingLines,
    ...packetLines,
    ...targetLines,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 장면 헤더 — 모델이 첫 줄에 적는 시점. 시계를 움직이는 유일한 입구다.
 * 일상 `[2026-07-13 오후]` · 경기 `[67']`. 형식이 어긋나면 시간이 멈춘다(로그로 드러낸다).
 * ⚠️ 날짜만 필수 — 시:분을 필수로 좁히면 `[2026-07-20 월요일 오전]`을 못 잡아
 * 시계가 며칠씩 멈춘다.
 */
const SCENE_HEADER_RE = new RegExp(
  [
    /^\[\s*(\d{4}-\d{2}-\d{2})/, // 날짜 — 이것만 필수
    /(?:\s*[,·]?\s*\(?\s*[월화수목금토일](?:요일)?\s*\)?)?/, // 요일 (수) · 월요일
    /(?:\s*[,·]?\s*(AM|PM|오전|오후|아침|점심|저녁|밤|새벽))?/, // 시간대
    /(?:\s*(\d{1,2}):(\d{2}))?/, // 시각
    /\s*\]/,
  ]
    .map((r) => r.source)
    .join(""),
  "i",
);
const MATCH_HEADER_RE = /^\[\s*(\d{1,3})\s*['′분]?\s*\]/;

/** 시간대만 적힌 헤더의 기본 시각 — 하루 안에서 되감기지 않을 만큼만 민다 */
const PART_OF_DAY: Record<string, string> = {
  새벽: "06:00",
  아침: "08:00",
  오전: "09:00",
  am: "09:00",
  점심: "12:30",
  오후: "14:00",
  pm: "14:00",
  저녁: "19:00",
  밤: "21:00",
};

/**
 * `AM 9:30` · `PM 7:05` · `14:30` → "HH:MM" (24시간). 읽을 수 없으면 null.
 *
 * ⚠️ **시간대가 붙었는지가 12시간제인지를 가른다.** 시간대 없는 `14:30`까지 12로
 * 접으면 `02:30`이 되어 시각이 오전으로 뒤집히고, 코어가 되감기를 막으므로 그 턴의
 * 시계가 통째로 멎는다. 그래서 시간대가 없으면 적힌 값이 곧 24시간 값이다 —
 * `오전 12:05`는 자정 00:05, 시간대 없는 `12:05`는 정오 12:05.
 */
function toClock(meridiem: string | undefined, hour: string, minute: string): string | null {
  const h = Number(hour);
  if (h > 23 || Number(minute) > 59) return null;
  const h24 = meridiem ? (h % 12) + (/^(PM|오후|저녁|밤)$/i.test(meridiem) ? 12 : 0) : h;
  return `${String(h24).padStart(2, "0")}:${minute}`;
}

/** 헤더가 가리키는 시각 — 시:분이 있으면 그것, 없으면(또는 읽을 수 없으면) 시간대의 기본값 */
function clockFromHeader(meridiem: string | undefined, hour?: string, minute?: string): string {
  const clock = hour && minute ? toClock(meridiem, hour, minute) : null;
  return clock ?? PART_OF_DAY[(meridiem ?? "").toLowerCase()] ?? "09:00";
}

/** 위생이 지금까지 본 것 — 직전에 살린 헤더는 무엇이었나, 장면이 열렸나 */
interface SceneScan {
  /** 마지막으로 살아남은 시점 헤더의 값 — 아직 하나도 없으면 null */
  lastHeader: string | null;
  /** 첫 `@` 줄이 지나갔다 — 그 뒤의 태그 없는 줄은 이어쓰기다 */
  sceneOpen: boolean;
  /** 열려 있는 꺾쇠 블록의 이름 — 그 안의 줄은 어느 국면에서도 장면이 아니다 */
  block: string | null;
  /** 헤더·작업 로그 규칙까지 거는가 — 중계는 꺾쇠 규칙 하나만 읽는다 */
  scenes: boolean;
}

/** 헤더 값 비교용 — 안쪽 공백의 차이는 같은 시각이다 */
function headerKey(line: string): string {
  return line.trim().replace(/\s+/gu, " ");
}

/**
 * 줄 앞머리의 여는 태그 이름 — `<targets max="2">` · `<ledger>` (`</…>`·`<…/>`는 아니다).
 *
 * ⚠️ 이름은 **글자로 열린다**(`\p{L}`) — 코어의 블록은 영어지만 모델이 지어내는
 * 태그는 한글일 수 있고(`<생각>`), 숫자로 여는 것은 태그가 아니라 부등호다(`3 < 4`).
 */
const OPENS_TAG_RE = /^<([\p{L}_][\p{L}\p{N}_-]*)(?:\s[^<>]*)?>/u;
/** 줄 하나로 끝난 꺾쇠 — 짝 없는 닫는 태그이거나 스스로 닫은 태그 */
const LONE_TAG_RE = /^<\/[\p{L}_][\p{L}\p{N}_-]*\s*>$|^<[\p{L}_][\p{L}\p{N}_-]*(?:\s[^<>]*?)?\/>$/u;

/** 이 줄이 그 이름의 블록을 닫는가 — 한 줄로 여닫은 블록도 여기서 걸린다 */
function closesTag(trimmed: string, name: string): boolean {
  return new RegExp(`</${name}\\s*>`, "u").test(trimmed);
}

/** 장면이 다시 서는 줄인가 — 화자(`@`)이거나 시점 헤더(`[`)다 */
function opensScene(trimmed: string): boolean {
  return trimmed.startsWith("@") || trimmed.startsWith("[");
}

/**
 * 꺾쇠로 여닫는 블록은 **읽는 것**이고 장면이 아니다 (prompts.md §1).
 *
 * `<targets>`·`<ledger>`는 코어가 읽으라고 넣어 준 입력 구조인데, 모델이 그것을
 * 되받아 쓰면 프롬프트 내부 구조가 감독이 읽는 자리에 그대로 선다. 평시도 중계도
 * 이 한 규칙을 함께 읽는다.
 *
 * 판정은 **줄 단위**다 — `@`로 연 줄 안의 꺾쇠는 대사의 일부라 손대지 않는다.
 */
function opensTagBlock(trimmed: string): string | null {
  const opened = OPENS_TAG_RE.exec(trimmed);
  // 한 줄에서 여닫았으면 블록을 열지 않는다 — 그 줄 하나만 걷힌다
  return opened && !closesTag(trimmed, opened[1] ?? "") ? (opened[1] ?? "") : null;
}

/** 줄 전체가 꺾쇠 하나인가 — 열든 닫든 스스로 닫든, 장면에는 설 수 없다 */
function isTagLine(trimmed: string): boolean {
  return trimmed.startsWith("<") && (OPENS_TAG_RE.test(trimmed) || LONE_TAG_RE.test(trimmed));
}

/**
 * 장면에 설 수 있는 줄인가 — 꺾쇠 블록 밖이면서, 시점 헤더(**직전 것과 값이 다른 것**),
 * `@`로 시작하는 화자·내레이션, 빈 줄(문단 간격), 그리고 **장면이 선 뒤의 이어쓰기
 * 줄**(prompts.md §1). 중계(`scenes: false`)는 꺾쇠 규칙까지만 읽는다.
 *
 * ⚠️ 이어쓰기가 되는 것은 첫 `@` 줄 **뒤**부터다 — 그 앞의 태그 없는 줄은 도구
 * 앞에 흘린 작업 로그라, 살리면 "…확인하겠습니다"가 코치의 대사로 붙는다.
 * 헤더 꼴(`[`)은 이어쓰기보다 헤더 규칙이 앞선다.
 *
 * ⚠️ **뒤 헤더를 일괄로 걷지 않는다.** 도구 반복이 다시 찍는 헤더는 값이 같고, 한 턴
 * 안에서 오전 훈련 뒤 오후 면담을 여는 헤더는 값이 다르다 — 값 비교만이 소음과 전환을
 * 가른다. 일괄로 걷으면 그 전환이 화면에서 통째로 사라진다.
 */
function keepsSceneLine(line: string, scan: SceneScan): boolean {
  const trimmed = line.trim();
  // 닫히지 않은 블록은 장면이 다시 서는 줄에서 끝난다 — 짝 없는 꺾쇠 하나가
  // 그 뒤의 장면을 통째로 삼키지 않게 (prompts.md §1)
  if (scan.block !== null && !opensScene(trimmed)) return false;
  if (isTagLine(trimmed)) return false;
  if (!scan.scenes) return true;
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith("@")) return true;
  if (trimmed.startsWith("[")) return headerKey(trimmed) !== scan.lastHeader;
  return scan.sceneOpen;
}

/** 판정을 마친 줄이 다음 판정에 남기는 것 */
function afterSceneLine(line: string, scan: SceneScan): void {
  const trimmed = line.trim();
  if (scan.block !== null) {
    if (opensScene(trimmed)) scan.block = null;
    else {
      if (closesTag(trimmed, scan.block)) scan.block = null;
      // 블록 안에서는 헤더도 이어쓰기도 나지 않는다
      return;
    }
  } else if (trimmed.startsWith("<")) {
    scan.block = opensTagBlock(trimmed);
    if (isTagLine(trimmed)) return;
  }
  if (trimmed.startsWith("[")) scan.lastHeader = headerKey(trimmed);
  if (trimmed.startsWith("@")) scan.sceneOpen = true;
}

/** 걷어낸 자리에 남은 빈 줄이 겹치지 않게 (문단 간격은 하나면 족하다) */
function joinScene(kept: readonly string[]): string {
  return kept
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function sieve(text: string, scenes: boolean): string {
  const lines = text.split("\n");
  const scan: SceneScan = {
    lastHeader: null,
    sceneOpen: false,
    block: null,
    // ⚠️ **`@` 줄이 하나도 없으면 장면 규칙은 걸지 않는다** — 규약을 통째로 어긴
    // 응답까지 지우면 빈 턴이 되어 무슨 일이 있었는지조차 사라진다. 꺾쇠 블록은
    // 그런 응답에서도 걷는다 — 그것은 장면 규약이 아니라 프롬프트 내부 구조다
    scenes: scenes && lines.some((line) => line.trim().startsWith("@")),
  };
  const kept: string[] = [];
  for (const line of lines) {
    const keeps = keepsSceneLine(line, scan);
    afterSceneLine(line, scan);
    if (keeps) kept.push(line);
  }
  return joinScene(kept);
}

/**
 * 장면 위생 — **도구 앞에 흘린 작업 서술과 값이 같은 반복 헤더를 걷어낸다.**
 *
 * 도구를 부르는 턴에서 모델은 반복마다 "…확인하겠습니다" 한 줄과 헤더를 새로
 * 찍는다(프롬프트로 몇 번을 눌러도 남는 습성이다). 그 줄들은 장면이 아니라
 * 작업 로그인데 화면에는 코치의 말과 나란히 선다. 걷는 것은 **장면이 서기 전**의
 * 태그 없는 줄까지다 — 그 뒤의 것은 이어쓰기라 살린다.
 *
 * **시각이 달라진 헤더는 남는다** — 그것은 소음이 아니라 장면 전환이고, 화면이
 * 그 자리에서 시각 표시로 세운다(`cutStamps`).
 */
export function sanitizeSceneText(text: string): string {
  return sieve(text, true);
}

/**
 * 중계 위생 — **꺾쇠 블록만 걷는다** (prompts.md §1).
 *
 * 평시 규칙을 그대로 갖다 붙일 수 없다: 구간마다 헤더를 새로 찍는 것이 중계에서는
 * 정상이고, 이어쓰기의 경계도 다르다. 남는 것은 두 국면이 함께 읽는 좁은 규칙
 * 하나 — 모델이 `<targets>`를 되받아 써도 화면에도 저장에도 서지 않는다.
 */
export function sanitizeCasterText(text: string): string {
  return sieve(text, false);
}

/**
 * 스트리밍에도 같은 위생을 건다 — 걸러진 줄이 화면에 잠깐 떴다 사라지면
 * 그것대로 눈에 띈다. 줄의 **앞머리**와 여기까지 지나온 것(`SceneScan`)만 보면
 * 판정되므로, 지연되는 것은 줄 앞머리뿐이고 그다음 델타는 그대로 흘러간다.
 *
 * ⚠️ **헤더는 값을, 꺾쇠는 닫는 부등호를 봐야 판정된다** — 같은 시각이면 소음,
 * 달라졌으면 전환이고, `<`로 연 줄은 태그인지 대사인지가 `>`에서 갈린다. 그래서 그
 * 두 줄만 닫는 글자(또는 줄 끝)까지 기다린다. 32자 안의 줄이라 지연은 눈에 띄지 않는다.
 *
 * ⚠️ **상태(`afterSceneLine`)는 줄이 끝난 뒤 줄 전체로 민다** — 앞머리로 밀면 한 줄에서
 * 여닫은 블록(`<b>강조</b>`)이 스트리밍에서만 열린 채 남아, 화면과 저장이 갈린다.
 */
function filterStream(emit: (delta: string) => void, scenes: boolean): (delta: string) => void {
  let line = ""; // 이 줄에 지금까지 온 것 전부 — 판정과 무관하게 쌓는다
  let sent = 0; // 그중 이미 내보낸 글자 수
  let keeping: boolean | null = null; // 이 줄을 내보내는가 — null이면 판정 전
  const scan: SceneScan = { lastHeader: null, sceneOpen: false, block: null, scenes };

  /** 앞머리만으로 판정할 수 있는가 — 못 하면 닫는 글자를 기다린다 */
  const ready = (): boolean => {
    const head = line.trimStart();
    if (head.startsWith("<") && !head.includes(">")) return false;
    if (scan.scenes && head.startsWith("[") && !head.includes("]")) return false;
    return true;
  };
  /** 판정이 났으면 아직 안 나간 만큼을 흘려보낸다 */
  const pump = (): void => {
    if (keeping === null && line.trim().length > 0 && ready()) keeping = keepsSceneLine(line, scan);
    if (keeping === true && sent < line.length) {
      emit(line.slice(sent));
      sent = line.length;
    }
  };
  const endLine = (): void => {
    // 닫히지 않은 채 줄이 끝난 헤더·꺾쇠도 여기서 판정된다
    if (keeping === null && line.trim().length > 0) keeping = keepsSceneLine(line, scan);
    if (keeping === true && sent < line.length) emit(line.slice(sent));
    afterSceneLine(line, scan);
    // 줄바꿈은 살아남은 줄에만 붙인다 — 걸러진 줄은 자리도 남기지 않는다
    if (keeping !== false) emit("\n");
    line = "";
    sent = 0;
    keeping = null;
  };

  return (delta: string) => {
    const parts = delta.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) endLine();
      if (part.length > 0) {
        line += part;
        pump();
      }
    });
  };
}

/** 평시 스트리밍 — 헤더·작업 로그·꺾쇠를 함께 걷는다 */
export function filterSceneStream(emit: (delta: string) => void): (delta: string) => void {
  return filterStream(emit, true);
}

/** 중계 스트리밍 — 꺾쇠 블록만 걷는다 (`sanitizeCasterText`와 같은 규칙) */
export function filterCasterStream(emit: (delta: string) => void): (delta: string) => void {
  return filterStream(emit, false);
}

export interface ParsedScene {
  /** 헤더를 걷어낸 본문 */
  body: string;
  /**
   * 읽어낸 원문 헤더 줄 — 없으면 null. ⚠️ 저장할 때 본문에 되붙여야 한다 —
   * 떼면 화면(scene-stamp)의 시각이 스트리밍이 끝나는 순간 사라진다.
   */
  header: string | null;
  point: ScenePoint | null;
  /** 경기 헤더의 목표 분 */
  minute: number | null;
}

/** 한 줄이 가리키는 시점 — 평시의 시점 헤더가 아니면 null (경기 분 헤더도 아니다) */
function scenePointOf(line: string): ScenePoint | null {
  const scene = SCENE_HEADER_RE.exec(line.trim());
  if (!scene) return null;
  // 시각을 빼먹었으면 시간대의 기본 시각, 그것도 없으면 그 날의 시작
  return { date: scene[1] ?? "", clock: clockFromHeader(scene[2], scene[3], scene[4]) };
}

/**
 * 턴이 **닿은 시각** — 시점 헤더가 여럿이면 마지막 것이다.
 *
 * 한 턴 안에서 시간이 흐르면 위생이 그 전환 헤더를 남기므로(prompts.md §1), 장면이
 * 실제로 도착한 곳은 마지막 헤더다. 시계를 첫 헤더로만 밀면 채팅은 오후를 세우는데
 * 상단 띠는 오전에 남아 **한 화면의 두 시계가 갈린다.**
 */
export function lastScenePoint(text: string): ScenePoint | null {
  let point: ScenePoint | null = null;
  for (const line of text.split("\n")) {
    const here = scenePointOf(line);
    if (here) point = here;
  }
  return point;
}

/** 첫 줄의 헤더를 떼어 시점을 읽는다. 헤더가 없으면 시간은 흐르지 않는다. */
export function parseSceneHeader(text: string): ParsedScene {
  const lines = text.split("\n");
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstIndex < 0) return { body: text, header: null, point: null, minute: null };
  const first = (lines[firstIndex] ?? "").trim();

  const point = scenePointOf(first);
  if (point) {
    const rest = [...lines.slice(0, firstIndex), ...lines.slice(firstIndex + 1)];
    return { body: rest.join("\n").trim(), header: first, point, minute: null };
  }
  const match = MATCH_HEADER_RE.exec(first);
  if (match) {
    const rest = [...lines.slice(0, firstIndex), ...lines.slice(firstIndex + 1)];
    return { body: rest.join("\n").trim(), header: first, point: null, minute: Number(match[1]) };
  }
  return { body: text, header: null, point: null, minute: null };
}

/** 경기 장면의 첫 줄 — 시계의 주인이 장부라 코어가 직접 쓴다 */
function matchHeader(minute: number): string {
  return `[${minute}']`;
}

/** 헤더 한 줄인가 — 대괄호로 열고 닫은 줄 하나 (`[43']` · `[2026-07-18 오후]`) */
const BRACKET_LINE_RE = /^\s*\[[^\]]*\]\s*$/u;

/**
 * **경기 장면의 시각은 장부가 붙인다** (agents.md §3 ④).
 *
 * 평시의 첫 줄 헤더는 시계를 옮기는 입구지만 경기의 시계 주인은 장부다. 캐스터가
 * 적은 분은 걷어내고 그 자리에 장부의 분을 세운다 — 대화만 한 턴에 `[12']`를 적어
 * 감독이 지나가지도 않은 12분 위에 다음 지시를 쌓던 자리다.
 */
export function stampMatchScene(text: string, minute: number): string {
  return `${matchHeader(minute)}\n${parseSceneHeader(text).body}`;
}

/**
 * 스트리밍에도 같은 주인 — **코어의 시각 줄이 먼저 나가고 모델의 첫 줄은 화면에
 * 닿기 전에 걷힌다.** 사후 교정만 하면 라이브 화면이 잠깐 다른 분을 보여 준다.
 *
 * 판정에 필요한 것은 첫 줄뿐이라 지연되는 것도 첫 줄뿐이다. 헤더일 수 없다고
 * 판정되는 순간(`[`로 열지 않았다) 그 자리에서 흘려보낸다.
 */
export function stampMatchStream(
  /** 장부의 분 — 함수면 **첫 델타가 나가는 순간**에 읽는다 (도구가 시계를 옮긴 뒤다) */
  minute: number | (() => number),
  emit: (delta: string) => void,
): (delta: string) => void {
  let opened = false;
  /** 아직 판정하지 못한 첫 줄. `null`이면 판정이 끝나 그대로 흘려보낸다 */
  let head: string | null = "";
  const flush = (rest: string): void => {
    head = null;
    if (rest.length > 0) emit(rest);
  };
  return (delta: string) => {
    if (!opened) {
      emit(`${matchHeader(typeof minute === "function" ? minute() : minute)}\n`);
      opened = true;
    }
    if (head === null) {
      emit(delta);
      return;
    }
    head += delta;
    for (;;) {
      const nl = head.indexOf("\n");
      if (nl < 0) {
        if (head.trim().length > 0 && !head.trimStart().startsWith("[")) flush(head);
        return;
      }
      const first = head.slice(0, nl);
      const rest = head.slice(nl + 1);
      // 코어가 이미 첫 줄을 세웠으므로 그 앞의 빈 줄은 자리도 남기지 않는다
      if (first.trim().length === 0) {
        head = rest;
        continue;
      }
      flush(BRACKET_LINE_RE.test(first) ? rest : `${first}\n${rest}`);
      return;
    }
  };
}

/**
 * 지금이 경기 중인가 — 이력을 가르는 기준이자 창을 가르는 기준이다.
 *
 * 킥오프 멘트 턴은 아직 **라커룸의 연장**이다 — 경기 이력이 비어 있고 첫 마디를
 * 여는 근거는 경기 전 대화(팀토크·브리핑)다. 그래서 그 한 턴만 평시로 읽는다.
 */
function inMatchNow(state: GameState): boolean {
  return state.phase === "match" && state.pendingMatch?.entered === true;
}

/**
 * 평시와 경기의 이력을 가른다 — 섞이면 토큰만이 아니라 맥락이 오염된다
 * (경기 중 이력의 이적 이야기를 중계가 끌어온다). 두 국면은
 * buildMatchBrief·matchDigest가 잇는다.
 */
function relevantTurns(state: GameState): typeof state.chat {
  const inMatch = inMatchNow(state);
  const here = state.pendingMatch?.matchId;
  return state.chat.filter((t) =>
    inMatch
      ? // 경기 중 — 이 경기의 턴만. 다른 경기의 중계도 남의 이야기다
        t.inMatch === true && (here === undefined || t.matchId === undefined || t.matchId === here)
      : t.inMatch !== true,
  );
}

/**
 * 이력이 끝나는 자리 — 뒤에서부터 **모델 턴이 나올 때까지가 이번 턴의 입력**이다.
 *
 * 한 턴은 채팅에 하나가 아니라 여럿을 남긴다(전술판 조작이 오퍼레이터 턴으로 먼저
 * 서고 감독 발화가 그 뒤에 선다). 저장이 성공한 채팅은 언제나 모델 턴으로 끝나므로
 * (실패한 턴은 저장되지 않는다) 꼬리의 비-모델 턴이 곧 이번 턴에 밀어 넣은 입력이고,
 * 그것들은 이번 호출의 발화 블록이 이미 싣는다.
 *
 * ⚠️ 한 줄만 빼면 두 자리에서 틀린다 — 조작이 이력과 발화 블록에 두 번 실리고,
 * 킥오프처럼 이번 턴 발화가 경기 이력으로 갈린 턴에서는 뺄 줄이 이 목록에 애초에
 * 없어 직전 평시 발화가 대신 잘려 나간다.
 */
function historyEnd(chat: GameState["chat"]): number {
  for (let i = chat.length - 1; i >= 0; i -= 1) if (chat[i]?.role === "model") return i + 1;
  return 0;
}

/**
 * 이력 창 **안에** 서 있는 카드 — 인물 사전이 「이미 실렸다」를 판단하는 근거다.
 *
 * 창 밖으로 밀려난 기록은 여기 오지 않으므로 그 인물은 그 순간 다시 주입 대상이
 * 된다 — 만료 규칙을 따로 두지 않는 이유다 (people.md §6).
 */
export function injectedCharacters(state: GameState): CharacterInjection[] {
  return windowOf(state).turns.flatMap((turn) => turn.characters ?? []);
}

/**
 * 이번 턴의 주입을 **입력으로 밀어 넣은 그 턴에** 기록한다.
 *
 * 카드는 감독 발화와 같은 층에 실리므로 이력에서도 그 자리에 다시 서야 한다.
 * 모델 턴에 붙이면 카드가 답변 뒤로 가 순서가 뒤집힌다. ⚠️ 기록만 남긴다 —
 * 카드 텍스트를 저장하면 채팅 화면에 프롬프트가 새고 이력이 그때의 문장으로 굳는다.
 *
 * 기억 줄 수도 함께 적는다 — 기억은 이 턴 층에만 서므로(§6), 그 뒤에 늘어난 것을
 * 재주입으로 나르려면 인물 사전이 **그때 실린 수**를 알아야 한다.
 */
export function recordCharacterInjection(
  state: GameState,
  entries: readonly CharacterEntry[],
): void {
  if (entries.length === 0) return;
  const turn = state.chat[state.chat.length - 1];
  // 이번 턴에 밀어 넣은 입력이 꼬리다 (`historyEnd`) — 모델 턴이면 저장이 끝난
  // 이력이라 붙일 자리가 아니다
  if (!turn || turn.role === "model") return;
  turn.characters = entries.map((e) => ({
    characterId: e.characterId,
    depth: e.depth,
    memories: e.memories?.length ?? 0,
  }));
}

/**
 * 이력 창 — 어디서부터 어디까지가 이번 호출의 이력인가. **평시의 시작점은 코어가
 * 정한다** (`historyStart` → agents.md §5-1: 글자 상한 안에 드는 가장 앞의 6턴 경계).
 * 코어가 고르는 평시 턴(`peaceTurns`)과 `relevantTurns`의 평시 갈래가 같은 필터
 * (`inMatch !== true`)라 접힌 지점의 인덱스가 이 목록에 그대로 맞는다.
 */
function windowOf(state: GameState): { turns: GameState["chat"] } {
  const chat = relevantTurns(state);
  const upto = historyEnd(chat);
  // 경기 이력은 접히지 않는다 — 경기마다 리셋돼 자라지 않는다 (agents.md §5-1).
  // 접은 지점은 평시의 것이라 이 목록에 먹이면 엉뚱한 자리를 자른다
  const start = inMatchNow(state) ? 0 : historyStart(state);
  return { turns: chat.slice(start, upto) };
}

/**
 * 한 턴의 입력을 유저 메시지 하나로 — 인물 카드 → 화면 조작 → 감독 발화.
 *
 * 한 턴은 채팅에 여럿을 남기지만(조작이 먼저, 발화가 뒤 — `historyEnd`) 모델에는
 * 메시지 하나로 간다. **보낼 때도 이력에서 다시 그릴 때도 이 함수다** —
 * 이번 턴(`buildGmTurnMessage`)과 이력(`buildGmHistory`)이 다른 손으로 그리면 같은
 * 자리가 글자부터 갈려 캐시 프리픽스가 지난 발화 앞에서 끊기는데, 화면에는 아무
 * 증상이 없다 (agents.md §5 · prompts.md §5-1 원칙 12).
 *
 * 카드가 발화 앞이다 — 이력에 남는 것들 안의 순서라 캐시와 무관하고, 대본이 그렇듯
 * 등장인물이 대사보다 먼저다. 이력에 남지 않는 스냅샷은 이 메시지 밖, 그 뒤에 어댑터가
 * 붙인다 (models.md §3-3).
 */
export function renderTurnGroup(
  state: GameState,
  turns: ReadonlyArray<Pick<ChatTurn, "role" | "text">>,
  cards: readonly CharacterEntry[],
): string {
  return [
    describeCharacters(cards),
    // 오퍼레이터 지시도 같은 유저 메시지 안이다 — 갈리는 건 **내용의 형식**이다.
    // 감독 발화인지 조작인지를 본문이 밝힌다
    ...turns.map((turn) =>
      turn.role === "operator"
        ? buildOperatorMessage(turn.text)
        : buildManagerMessage(state, turn.text),
    ),
  ]
    .filter((block): block is string => block !== null)
    .join("\n\n");
}

/**
 * 이번 턴의 유저 메시지 — 이력이 끝난 자리(`historyEnd`)부터 꼬리까지가 이번 턴에
 * 밀어 넣은 입력이다. 카드는 아직 꼬리에 기록되기 전이라(`recordCharacterInjection`은
 * 턴이 끝난 뒤다) 고른 것을 그대로 받는다.
 *
 * ⚠️ 꼬리가 비어 있으면 빈 메시지다 — 부르는 쪽(`turn-runner`)이 이번 턴의 조작과
 * 발화를 채팅에 먼저 밀어 넣는 것이 이 함수의 전제이고, `historyEnd`·
 * `recordCharacterInjection`도 같은 전제 위에 선다.
 */
export function buildGmTurnMessage(state: GameState, cards: readonly CharacterEntry[]): string {
  const chat = relevantTurns(state);
  return renderTurnGroup(state, chat.slice(historyEnd(chat)), cards);
}

export function buildGmHistory(
  state: GameState,
): Array<{ role: "user" | "assistant"; content: string }> {
  return groupTurns(windowOf(state).turns).map((group) =>
    group[0]?.role === "model"
      ? { role: "assistant" as const, content: group.map((turn) => turn.text).join("\n\n") }
      : {
          role: "user" as const,
          // 그 턴에 실었던 카드를 같은 자리에 다시 붙인다 — 세이브에는 기록만 있고
          // 문장은 매번 여기서 만들어진다 (people.md §6)
          content: renderTurnGroup(
            state,
            group,
            entriesOf(
              state,
              group.flatMap((turn) => turn.characters ?? []),
            ),
          ),
        },
  );
}

/**
 * 연속된 비-모델 턴을 한 묶음으로 — 한 턴의 입력이 보낼 때 메시지 하나였으므로 이력에서도
 * 하나다. 모델 턴은 저마다 한 묶음이다.
 */
function groupTurns(turns: readonly ChatTurn[]): ChatTurn[][] {
  const groups: ChatTurn[][] = [];
  for (const turn of turns) {
    const last = groups[groups.length - 1];
    if (last && turn.role !== "model" && last[0]?.role !== "model") last.push(turn);
    else groups.push([turn]);
  }
  return groups;
}

/** 기록 → 인물지. 세계에서 사라진 이름은 조용히 빠진다 (방출된 선수) */
function entriesOf(state: GameState, injected: readonly CharacterInjection[]): CharacterEntry[] {
  return injected
    .map((record) => characterEntryOf(state, record.characterId, record.depth))
    .filter((entry): entry is CharacterEntry => entry !== null);
}
