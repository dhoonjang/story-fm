/**
 * GM 입력 빌더 — 레퍼런스(캐시층)·상태 스냅샷·경기 장부 노트·장면 헤더 파서·
 * 대화 이력 창. 입력은 변경 빈도 순 3층이다 (docs/llm/agents.md).
 */
import {
  characterEntry,
  characterEntryOf,
  clockOf,
  computeStandings,
  dayOfWeek,
  describeNegotiations,
  describeNextFixture,
  describePendingApproach,
  describePendingPress,
  describeWindowState,
  expiringContracts,
  financeOf,
  formatClock,
  headCoachOf,
  historyStart,
  isSuspended,
  MAX_EXPLOITS,
  openInjury,
  pendingVerdicts,
  playerName,
  scoutingSummary,
  scoutReportLine,
  speakerCues,
  squadFamiliarity,
  squadLevelOf,
  squadReturnOf,
  subLimitsOf,
  tacticsOf,
  teamName,
  userPlayers,
  weeklyWagesOf,
  type GameState,
  type ScenePoint,
} from "@story-fm/engine";
import {
  formatMoney,
  personaRoleLabel,
  slotOfTime,
  type CharacterEntry,
  type CharacterInjection,
  type ScoutReportCard,
} from "@story-fm/domain";

/** 경기 브리핑에 그대로 싣는 직전 평시 감독 발화 수 */
const MATCH_BRIEF_TURNS = 3;
/** 경기 다이제스트가 "방금 있었던 일"로 치는 기간 (일) */
const MATCH_DIGEST_DAYS = 3;
/** 계약 만료 임박 경고 창 (일) */
const EXPIRING_ALERT_DAYS = 180;

/**
 * 인물 카드 — 인물지를 모델이 읽는 형태로 (people.md §6).
 *
 * 예시 대사까지 실어야 모델이 톤을 흉내 내는 대신 그 사람으로 말한다. 무엇이 실리고
 * 무엇이 빠지는지는 **깊이**가 정하고, 그 판단은 코어(`characterEntry`)의 것이다 —
 * 여기서는 온 것을 문장으로 옮기기만 한다.
 */
export function describePersona(entry: CharacterEntry): string {
  const label = personaRoleLabel(entry.role);
  return [
    `[인물] ${entry.name} — ${label ? `${label} · ` : ""}${entry.archetype}`,
    `성격: ${entry.traits.join(" · ")}`,
    ...(entry.motivation ? [`동기: ${entry.motivation}`] : []),
    ...(entry.speechStyle ? [`말투: ${entry.speechStyle.note}`] : []),
    ...(entry.speechStyle?.samples ?? []).map((s) => `  예) ${s}`),
    // 감독이 아는 만큼만 그린다 — 소문으로만 아는 사람에게 속내를 주면 만난 적 없는
    // 사람의 목소리가 난다
    ...(entry.depth === "rumour"
      ? [`⚠️ 평판으로만 아는 사람이다 — 말투도 속내도 모른다. 소문의 수준에서만 그려라.`]
      : []),
    // 인물지(성격·동기·말투)는 세이브당 불변이고 기억은 있었던 일이다 — 갱신되는 자리가
    // 압축 한 곳뿐이라 카드가 이력에 굳어도 낡지 않는다 (people.md §9-1)
    ...(entry.memories?.length
      ? [`있었던 일:`, ...entry.memories.map((m) => `  ${m.date} — ${m.text}`)]
      : []),
    // 직책이 아니라 이름으로 말한다 — 규칙은 시스템 프롬프트(출력 문법)에 한 번만 선다
    `화자 태그: @${entry.characterId}:`,
    // 실명 인물 — 평판을 해칠 서사 금지 가드와 세트로만 운용한다 (sources.md §7)
    ...(entry.real
      ? [
          `⚠️ 실존 인물이다. 직무 안에서 유능하게 그리고, 실제 인물의 평판을 해칠 서사 — 비위·불화·무능·사생활 — 는 만들지 않는다.`,
        ]
      : []),
  ].join("\n");
}

/**
 * 이번 장면의 인물들 — 캐릭터북이 고른 카드 묶음 (people.md §6).
 *
 * ⚠️ **여기 있는 것은 "이 사람이 누구인가"뿐이다.** 카드는 이력에 굳으므로 변하는
 * 값(폼·컨디션·부상·심경·계약)이 들어가면 3주 뒤 모델이 낡은 사실로 말한다. 그래서
 * 블록 끝이 조회를 가리킨다 — 카드가 섰다는 건 그 인물이 이번 장면에 선다는 뜻이고,
 * 그것이 곧 조회할 근거다. 포인터는 카드마다가 아니라 묶음에 한 번만 선다.
 */
export function describeCharacters(entries: readonly CharacterEntry[]): string | null {
  if (entries.length === 0) return null;
  return [
    `[이번 장면의 인물]`,
    ...entries.map(describePersona),
    `지금의 사실 — 폼·컨디션·부상·심경·계약·능력치 — 은 이 카드에 없다. 그 인물을 두고 사실을 말하기 전에 조회로 확인하라.`,
  ].join("\n\n");
}

/**
 * 레퍼런스 블록 — 캐시되는 시스템 블록. 감독 프로필 + 선수단 규칙.
 *
 * ⚠️ **인물 카드는 여기 없다.** 코치·구단주·기자 다섯 장은 회견도 협상도 없는 턴에
 * 한 번도 쓰이지 않는데 매 턴 읽혔다. 그렇다고 조건부로 넣었다 뺐다 하면 더 나쁘다 —
 * 프리픽스가 바뀌는 턴마다 이 블록과 그 뒤 이력이 통째로 무효가 된다. 카드는 캐릭터북이
 * 골라 **이번 턴 층**에 싣고 다음 턴부터 이력의 일부가 된다 (people.md §6).
 * ⚠️ 선수의 이름도 id도 여기 두지 않는다 — 명단은 영입·매각·2군 승격·주장 변경마다
 * 바뀌고, 한 줄이 달라지면 이 블록과 그 뒤의 이력이 통째로 무효가 된다. 이름은 매 턴
 * 층(`buildGmStateNote`)의 「선수단」 줄이 싣는다.
 * ⚠️ 감독의 능력·평판도 마찬가지다 — 경기마다 평판이 움직이고 능력도 자라므로
 * 여기 있으면 경기 한 번에 이 블록과 그 뒤가 통째로 무효가 된다. 수치는 매 턴 층
 * (`buildGmStateNote`)이 싣고 여기엔 이름과 배경만 남는다.
 */
export function buildGmReference(state: GameState): string {
  const m = state.manager;
  return [
    `[감독 프로필]`,
    `이름: ${m.name}`,
    `배경: ${m.background}`,
    `감독 발화 화자 형식: @${m.name}: <발화> — 당신은 이 화자를 대신 연기하지 않는다.`,
    ``,
    // ⚠️ 이름이 아니라 규칙이다 — 목록을 되살리면 캐시가 명단과 함께 깨지고,
    // 그 목록은 다시 id 표로 읽혀 한 번 불린 선수만 계속 말한다
    `[${teamName(state.userTeamId)} 선수단]`,
    `선수의 이름은 상태 스냅샷의 「선수단」 줄에 있다. 스킬의 선수 인자도 그 이름으로 받는다 — 조회가 돌려준 id를 적어도 된다.`,
    `능력치·배치·컨디션·계약은 get_squad·search_players가 준다.`,
  ].join("\n");
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
  return [
    `[접힌 대화의 요약]`,
    `이력 창 밖으로 밀려난 지난 대화를 ${digest.at}에 요약한 것이다. 아래 이력은 그 뒤부터다.`,
    digest.text,
  ].join("\n");
}

/** 유저의 자연어를 모델이 읽는 감독 화자 형식으로 감싼다. */
export function buildManagerMessage(state: GameState, message: string): string {
  return `@${state.manager.name}: ${message}`;
}

/**
 * 화면 조작 — 감독의 발화가 아니다. **모델의 출력 문법 밖 봉투로 싣는다**
 * (`[조작: 시간 진행 — 하루]`). `@:`는 GM이 내레이션을 쓰는 채널이라 거기 담으면
 * 감독의 화면 조작이 모델 자신의 문법으로 이력에 서고, 인물이 그 손잡이를 아는
 * 것으로 읽힌다 (docs/llm/prompts.md §1).
 */
export function buildOperatorMessage(message: string): string {
  return `[조작: ${message}]`;
}

/**
 * 경기 캐시 레퍼런스 — 경기 내내 변하지 않는 것만 담는다.
 * ⚠️ 패킷은 매 구간 갱신되므로 여기 두면 캐시 프리픽스가 매 턴 깨진다 —
 * 휘발 채널(`buildLedgerNote`)로 내려간다.
 */
export function buildMatchReference(state: GameState): string {
  return [
    `[감독]`,
    `이름: ${state.manager.name}`,
    `감독 발화 화자 형식: @${state.manager.name}: <발화>`,
    ``,
    // 벤치에서 감독 옆에 서 있는 사람이다 — 경기 중 조언도 같은 사람의 말투여야 한다.
    // 경기 내내 같은 한 사람이라 여기서는 캐릭터북을 거치지 않고 상주한다
    describePersona(characterEntry(headCoachOf(state), "full")),
    ``,
    buildMatchBrief(state),
  ].join("\n");
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
  return [`[경기 전 감독이 한 말]`, ...said].join("\n");
}

const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * 경기 → 평시 다리 — 직전 경기의 결과·득점·최고 평점을 코어가 장부에서 뽑는다
 * (평시 GM은 중계 이력을 보지 않는다). 직전 한 경기만 — 그 이상은 get_league의 몫.
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
  return [
    `직전 경기 (${played.date}): ${ours ? "홈" : "원정"} vs ${opponent} ${us}-${them} ${verdict}`,
    scorers ? `  득점: ${scorers}` : null,
    best ? `  최고 평점: ${best}` : null,
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
const EXPIRING_SHOWN = 3;
const RECENT_NARRATIVE = 4;

export function buildGmStateNote(
  state: GameState,
  passed?: TimePassed | null,
  /** 이번 턴에 카드로 서는 보고서 — 카드가 프롬프트에 못 가므로 값은 여기로 온다 */
  arrivedReports: readonly ScoutReportCard[] = [],
): string {
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
  const suspended = players.filter((p) => isSuspended(state, p.id)).map((p) => p.name);
  const unhappy = state.issues.map((i) => playerName(state, i.gamePlayerId));

  const training = state.schedule
    .filter((e) => e.type === "training" && e.status === "scheduled" && e.date >= state.date)
    .slice(0, TRAINING_SHOWN)
    .map((e) => {
      const s = state.trainingSessions.find((x) => x.id === e.refId);
      return `${e.date.slice(5)} ${slotOfTime(e.time) === "am" ? "오전" : "오후"} ${s?.label ?? "훈련"}`;
    });
  const trainingCount = state.schedule.filter(
    (e) => e.type === "training" && e.status === "scheduled" && e.date >= state.date,
  ).length;

  const alerts = [
    // 판정 대기 협상이 맨 앞 — 답은 다음 턴 입력에 실리므로 여기서 세우지 않으면 잊힌다
    ...pendingVerdicts(state).map((v) => `❗ ${v.label} (${v.negotiation.id})`),
    injured.length > 0 ? `부상 ${injured.length} (${injured.join(", ")})` : null,
    suspended.length > 0 ? `정지 ${suspended.length} (${suspended.join(", ")})` : null,
    unhappy.length > 0 ? `불만 ${unhappy.length} (${unhappy.join(", ")})` : null,
    ...scoutingSummary(state),
    // 만료 임박 계약 — 재계약 서사의 씨앗. 놓치면 자유계약으로 떠난다
    (() => {
      const expiring = expiringContracts(state, EXPIRING_ALERT_DAYS);
      return expiring.length > 0
        ? `계약 만료 임박 ${expiring.length} (${expiring
            .slice(0, EXPIRING_SHOWN)
            .map((row) => `${row.player.name}~${row.contract.until}`)
            .join(", ")}${expiring.length > EXPIRING_SHOWN ? " …" : ""})`
        : null;
    })(),
  ].filter((x): x is string => x !== null);

  const lines = [
    `[상태 스냅샷 — 이 블록은 매 턴 갱신된다]`,
    `${state.date} (${DOW_KO[dayOfWeek(state.date)]}) ${formatClock(clockOf(state))} · 시즌 ${state.season}${
      played > 0 && rank > 0 ? ` · 리그 ${rank}위` : ""
    } · ${describeWindowState(state)}`,
    describeNextFixture(state),
    `전술: ${tac.formation} · 멘탈${tac.mentality} 라인${tac.defensiveLine} 압박${tac.pressing} 템포${tac.tempo} 폭${tac.width} 패스${tac.passStyle} · 선발 평균 적응 ${Math.round(squadFamiliarity(state, state.userTeamId))}`,
    `재정: 잔고 ${formatMoney(finance.balance)} · 주급 ${formatMoney(weeklyWagesOf(state, state.userTeamId))}/주 · 이적예산 ${formatMoney(finance.transferBudget)}`,
    // 감독의 수치는 캐시 밖이다 — 평판은 경기마다 움직이고 능력도 자란다.
    // 레퍼런스(감독 프로필)엔 이름·배경만 남는다
    `감독 ${state.manager.name}: 리더십${state.manager.attributes.leadership} 전술${state.manager.attributes.tactics} 훈련${state.manager.attributes.training} 협상${state.manager.attributes.negotiation} 분석${state.manager.attributes.analysis} · 평판 보드${state.manager.reputation.board} 미디어${state.manager.reputation.media} 선수단${state.manager.reputation.squad}`,
    // 부임 직후엔 선수단이 여름 휴가 중 — 소집일을 밝혀야 빈 훈련장을 지어내지 않는다
    state.date < squadReturnOf(state.calendar)
      ? `선수단 여름 휴가 중 — ${squadReturnOf(state.calendar)} 소집 (그 전에는 훈련을 잡을 수 없다)`
      : trainingCount > 0
        ? `예정 훈련 ${trainingCount}건: ${training.join(" / ")}${trainingCount > training.length ? " …" : ""}`
        : `예정 훈련 없음 — 기본 훈련까지 비워진 상태다`,
    alerts.length > 0 ? `주의: ${alerts.join(" · ")}` : `주의: 없음`,
    /**
     * 선수단 — **명단이지 화자 명단이 아니다.** 누가 말하는지는 캐릭터북이 세운
     * 카드가 정하고(people.md §6), 이 줄은 그 앞의 것을 한다: GM은 **모르는 선수를
     * 조회할 수 없으므로** 세계에 누가 있는지가 먼저 있어야 한다.
     *
     * 이름만 싣는다 — 배치·능력치·컨디션은 조회의 몫이고, 캐시 층이 아니라 여기인
     * 이유는 명단이 영입·승격·주장 변경마다 바뀌기 때문이다 (agents.md §5).
     */
    (() => {
      const named = (level: "first" | "reserve") =>
        players
          .filter((p) => squadLevelOf(p) === level)
          .map((p) => `${p.name}${p.isCaptain ? "(주장)" : ""}`);
      const first = named("first");
      const reserve = named("reserve");
      // 구분자는 쉼표가 아니라 가운뎃점이다 — 한국어 성명에 공백이 들어가서
      // 쉼표로 이으면 어디서 한 사람이 끝나는지가 흐려진다
      return [
        `선수단(${players.length}명)`,
        `  1군 ${first.length}: ${first.join(" · ")}`,
        ...(reserve.length > 0 ? [`  2군 ${reserve.length}: ${reserve.join(" · ")}`] : []),
      ].join("\n");
    })(),
    // 선수 근황 — 위 이름들 중 **사실이 붙는** 셋이다.
    // 코어는 사실만 낸다(speakerCues) — 누가 말할지, 무슨 말을 할지는 GM의 몫
    (() => {
      const cues = speakerCues(state);
      return cues.length > 0
        ? `선수 근황: ${cues.map((c) => `${c.name} ${c.fact}`).join(" · ")}`
        : null;
    })(),
    matchDigest(state),
  ].filter((x): x is string => x !== null && x !== "");
  // 그 사이 벌어진 일 — 손잡이로 시간을 넘긴 턴에만. 없으면 모델이 넘긴 구간의
  // 일(부상·오퍼)을 모른 채 장면을 쓴다
  if (passed && (passed.digest.length > 0 || passed.from !== state.date)) {
    lines.push(
      [
        `시간이 흘렀다: ${passed.from} → ${state.date} (${passed.stopped})`,
        `이미 그날이다 — 첫 줄 헤더에 ${state.date}을(를) 적어라.`,
        passed.digest.length > 0
          ? `그 사이 벌어진 일:\n${passed.digest.map((d) => `- ${d}`).join("\n")}`
          : `그 사이 특별한 일은 없었다.`,
      ].join("\n"),
    );
  }
  /**
   * 도착한 스카우트 보고서 — **이번 턴에 화면 카드로 서는 그것들이다.**
   *
   * 카드는 모델이 장면을 쓴 뒤에 붙어 프롬프트에 가지 않는다. 그래서 값이 여기
   * 없으면 모델은 카드 옆에서 금액을 지어내고, 한 화면이 두 말을 한다
   * (agents.md §6). 줄은 카드와 같은 함수에서 나온다 — `scoutReportLine`.
   */
  if (arrivedReports.length > 0) {
    lines.push(
      `도착한 스카우트 보고서 (감독 화면에 카드로 선다 — 금액은 이 값 그대로 말해라):\n${arrivedReports
        .map((c) => `- ${scoutReportLine(state, c.playerId) ?? c.name}`)
        .join("\n")}`,
    );
  }
  /**
   * 경기 뒤 들어온 소식 — 재정과 같은 라운드의 다른 경기·대진.
   *
   * 알림(대회 말풍선)에는 싣지 않는 갈래다(화면이 이미 갖고 있다). 그래도 모델은
   * 알아야 한다 — 순위가 뒤집힌 걸 모른 채 다음 장면을 쓰면 세계가 감독의 경기
   * 하나로 멈춘 것처럼 읽힌다. 읽기만 하고 비우지 않는다 (`takeNews`는 gm.ts).
   */
  const news = state.pendingNews ?? [];
  if (news.length > 0) {
    lines.push(`경기 뒤 들어온 소식:\n${news.map((n) => `- ${n}`).join("\n")}`);
  }
  // 채팅 턴 없는 화면 조작(전술판·명단·역할) — 이미 반영된 사실이라 모델은 반응만 한다
  const edits = state.pendingEdits ?? [];
  if (edits.length > 0) {
    lines.push(`감독이 화면에서 바꾼 것:\n${edits.map((e) => `- ${e.text}`).join("\n")}`);
  }
  // 답을 기다리는 기자회견 — 이 줄이 없으면 모델은 회견이 열린 사실 자체를 모른다
  const press = describePendingPress(state);
  if (press) lines.push(press);
  // 감독을 찾아온 사람 — 세계가 먼저 연 자리다 (people.md §8). 회견과 함께 서지 않는다
  const approach = describePendingApproach(state);
  if (approach) lines.push(approach);
  // 협상은 있을 때만 — 없으면 한 줄도 쓰지 않는다 (매 턴 정가로 읽히는 블록이다)
  const negotiations = describeNegotiations(state);
  if (!negotiations.startsWith("진행 중인 협상 없음")) {
    lines.push(`협상:\n${negotiations}`);
  }
  const recent = state.narrative.slice(-RECENT_NARRATIVE).map((n) => `${n.date} ${n.text}`);
  if (recent.length > 0) lines.push(`최근 사건: ${recent.join(" / ")}`);
  return lines.join("\n");
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
  const packet = options.withPacket === true ? pending.packet : null;
  /** 표적 목록은 판세와 갈린다 — 해석기는 수치 없이 이 목록만 읽는다 */
  const targets = options.withPacket === false ? [] : (pending.packet?.targets ?? []);
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
        `[현재 판세 — 구간마다 갱신]`,
        // 판세를 읽는 것은 모델의 일이다 — 코어는 이름·수치·상성 근거만 싣는다
        `${packet.home.teamName}(홈) vs ${packet.away.teamName} — 기대 득점 ${packet.guide.expectedGoals.home} : ${packet.guide.expectedGoals.away}`,
        packet.matchups.map((m) => m.why).join(" / "),
        ...packet.keyPoints.map((k) => `· ${k}`),
        `홈 전술 소화: ${Math.round(packet.home.tactical.uptake * 100)}%${
          packet.home.tactical.notes.length > 0
            ? ` — ${packet.home.tactical.notes.join(" / ")}`
            : ""
        }`,
        `어웨이 전술 소화: ${Math.round(packet.away.tactical.uptake * 100)}%${
          packet.away.tactical.notes.length > 0
            ? ` — ${packet.away.tactical.notes.join(" / ")}`
            : ""
        }`,
      ]
    : [];
  // 공략 후보 — 노릴 수 있는 지점은 이 목록이 전부다 (없는 지점은 코어가 반려)
  const targetLines =
    targets.length > 0
      ? [
          `[공략 가능한 지점 — 동시에 ${MAX_EXPLOITS}곳까지]`,
          ...targets.map((t) => `  ${t.id} — ${t.label}`),
          pending.exploits && pending.exploits.length > 0
            ? `지금 노리는 중: ${pending.exploits.join(", ")}`
            : `지금 노리는 곳 없음`,
        ]
      : [];
  /**
   * **지금 내가 무엇을 걸어 뒀는가** — 경기 중에는 평시 스냅샷(6축이 적힌 줄)이
   * 실리지 않아 여기가 유일한 자리다. 없으면 "압박 올려"에 지금 값이 지어내진다.
   */
  const ourTactics = tacticsOf(state, state.userTeamId).spec;
  const assignments = tacticsOf(state, state.userTeamId).assignments.filter(
    (a) => a.role === "starting" && (a.directive || a.instruction || a.roleId),
  );
  const standingLines = [
    ``,
    `[지금 걸어 둔 것]`,
    `전술 ${ourTactics.formation} · 멘탈${ourTactics.mentality} 라인${ourTactics.defensiveLine} ` +
      `압박${ourTactics.pressing} 템포${ourTactics.tempo} 폭${ourTactics.width} 패스${ourTactics.passStyle}`,
    pending.regionalPlans && pending.regionalPlans.length > 0
      ? `지역 전술: ${pending.regionalPlans
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
  ];
  // 사건은 싣지 않는다 — 코어가 이미 굴린 구간은 [이번 구간에 일어난 일]로 따로
  // 실린다. 이 블록은 그 구간이 끝난 자리의 장부다 (agents.md §3)
  /**
   * 교체 한도는 **국면이 정한다** — 연장은 6인/4회다 (match.md §5). 5/3으로 박아
   * 두면 연장에 들어간 모델이 아직 남은 카드를 없는 것으로 읽는다. 장부 검증과
   * AI 판단이 보는 것과 같은 함수다.
   */
  const subLimits = subLimitsOf(ledger.phase);
  return [
    `[경기 장부 — 매 턴 갱신]`,
    `스코어 ${ledger.score.home}:${ledger.score.away} · ${ledger.minute}′ · ${ledger.phase}`,
    `홈 온필드: ${withNames(ledger.home.onPitch)}`,
    `홈 벤치: ${withNames(ledger.home.bench)} (교체 ${ledger.home.subsUsed}/${subLimits.maxSubs}, 기회 ${ledger.home.subWindows}/${subLimits.maxSubWindows})`,
    `어웨이 온필드: ${withNames(ledger.away.onPitch)}`,
    `어웨이 벤치: ${withNames(ledger.away.bench)} (교체 ${ledger.away.subsUsed}/${subLimits.maxSubs}, 기회 ${ledger.away.subWindows}/${subLimits.maxSubWindows})`,
    ledger.sentOff.length > 0 ? `퇴장: ${withNames(ledger.sentOff)}` : "",
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

/**
 * 장면에 설 수 있는 줄인가 — 출력 문법이 허락하는 것은 셋뿐이다:
 * 시점 헤더(맨 앞 하나), `@`로 시작하는 화자·내레이션, 빈 줄(문단 간격).
 */
function keepsSceneLine(line: string, headerSeen: boolean): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith("@")) return true;
  return !headerSeen && trimmed.startsWith("[");
}

/**
 * 장면 위생 — **도구 앞에 흘린 작업 서술과 두 번째 시점 헤더를 걷어낸다.**
 *
 * 도구를 부르는 턴에서 모델은 반복마다 "…확인하겠습니다" 한 줄과 헤더를 새로
 * 찍는다(프롬프트로 몇 번을 눌러도 남는 습성이다). 그 줄들은 장면이 아니라
 * 작업 로그인데 화면에는 코치의 말과 나란히 선다.
 *
 * ⚠️ **@ 줄이 하나도 없으면 손대지 않는다** — 규약을 통째로 어긴 응답까지
 * 지우면 빈 턴이 되어 무슨 일이 있었는지조차 사라진다.
 */
export function sanitizeSceneText(text: string): string {
  const lines = text.split("\n");
  if (!lines.some((line) => line.trim().startsWith("@"))) return text;
  let headerSeen = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (!keepsSceneLine(line, headerSeen)) continue;
    if (line.trim().startsWith("[")) headerSeen = true;
    kept.push(line);
  }
  // 걷어낸 자리에 남은 빈 줄이 겹치지 않게 (문단 간격은 하나면 족하다)
  return kept
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * 스트리밍에도 같은 위생을 건다 — 걸러진 줄이 화면에 잠깐 떴다 사라지면
 * 그것대로 눈에 띈다. 줄의 **첫 글자**만 보면 판정되므로, 지연되는 것은
 * 줄 앞머리뿐이고 그다음 델타는 그대로 흘러간다.
 */
export function filterSceneStream(emit: (delta: string) => void): (delta: string) => void {
  let pending = ""; // 아직 판정하지 못한 줄 앞머리 (공백만 들어온 상태)
  let keeping: boolean | null = null; // 이 줄을 내보내는가 — null이면 판정 전
  let headerSeen = false;

  const startLine = () => {
    pending = "";
    keeping = null;
  };
  const feedLine = (chunk: string) => {
    if (keeping === false) return;
    if (keeping === true) {
      emit(chunk);
      return;
    }
    pending += chunk;
    if (pending.trim().length === 0) return; // 아직 공백뿐 — 판정 보류
    keeping = keepsSceneLine(pending, headerSeen);
    if (pending.trim().startsWith("[")) headerSeen = true;
    if (keeping) emit(pending);
    pending = "";
  };

  return (delta: string) => {
    const parts = delta.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) {
        // 줄바꿈은 살아남은 줄에만 붙인다 — 걸러진 줄은 자리도 남기지 않는다
        if (keeping !== false) emit("\n");
        startLine();
      }
      if (part.length > 0) feedLine(part);
    });
  };
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

/** 첫 줄의 헤더를 떼어 시점을 읽는다. 헤더가 없으면 시간은 흐르지 않는다. */
export function parseSceneHeader(text: string): ParsedScene {
  const lines = text.split("\n");
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstIndex < 0) return { body: text, header: null, point: null, minute: null };
  const first = (lines[firstIndex] ?? "").trim();

  const scene = SCENE_HEADER_RE.exec(first);
  if (scene) {
    const rest = [...lines.slice(0, firstIndex), ...lines.slice(firstIndex + 1)];
    // 시각을 빼먹었으면 시간대의 기본 시각, 그것도 없으면 그 날의 시작
    const clock = clockFromHeader(scene[2], scene[3], scene[4]);
    return {
      body: rest.join("\n").trim(),
      header: first,
      point: { date: scene[1] ?? "", clock },
      minute: null,
    };
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
  minute: number,
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
      emit(`${matchHeader(minute)}\n`);
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
 * 이력 창 **안에** 서 있는 카드 — 캐릭터북이 「이미 실렸다」를 판단하는 근거다.
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
  turn.characters = entries.map((e) => ({ characterId: e.characterId, depth: e.depth }));
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

export function buildGmHistory(
  state: GameState,
): Array<{ role: "user" | "assistant"; content: string }> {
  return windowOf(state).turns.map((turn) => ({
    // 오퍼레이터 지시도 user 역할로 간다(제공자 메시지는 user/assistant 교대다).
    // 갈리는 건 **내용의 형식**이다 — 감독 발화인지 조작인지를 본문이 밝힌다.
    role: turn.role === "model" ? ("assistant" as const) : ("user" as const),
    content:
      turn.role === "model"
        ? turn.text
        : // 그 턴에 실었던 카드를 같은 자리에 다시 붙인다 — 세이브에는 기록만 있고
          // 문장은 매번 여기서 만들어진다 (people.md §6)
          joinTurn(
            describeCharacters(entriesOf(state, turn.characters)),
            turn.role === "operator"
              ? buildOperatorMessage(turn.text)
              : buildManagerMessage(state, turn.text),
          ),
  }));
}

/** 기록 → 인물지. 세계에서 사라진 이름은 조용히 빠진다 (방출된 선수) */
function entriesOf(
  state: GameState,
  injected: readonly CharacterInjection[] | undefined,
): CharacterEntry[] {
  return (injected ?? [])
    .map((record) => characterEntryOf(state, record.characterId, record.depth))
    .filter((entry): entry is CharacterEntry => entry !== null);
}

function joinTurn(cards: string | null, body: string): string {
  return cards === null ? body : `${cards}\n\n${body}`;
}
