/**
 * GM 입력 빌더 — 레퍼런스(캐시층)·상태 스냅샷·경기 장부 노트·장면 헤더 파서·
 * 대화 이력 창. 입력은 변경 빈도 순 3층이다 (docs/llm/agents.md).
 */
import {
  clockOf,
  computeStandings,
  dayOfWeek,
  describeNegotiations,
  describeNextFixture,
  describePendingPress,
  describeWindowState,
  expiringContracts,
  financeOf,
  formatClock,
  headCoachOf,
  isSuspended,
  MAX_EXPLOITS,
  openInjury,
  ownerOf,
  pendingVerdicts,
  playerName,
  reportersOf,
  scoutingSummary,
  speakerCues,
  squadFamiliarity,
  squadLevelOf,
  squadReturnOf,
  tacticsOf,
  teamName,
  userPlayers,
  weeklyWagesOf,
  type GameState,
  type ScenePoint,
} from "@story-fm/engine";
import { naturalPositionOf, PERSONA_ROLE_LABEL, slotOfTime, type Persona } from "@story-fm/domain";

/** 경기 브리핑에 그대로 싣는 직전 평시 감독 발화 수 */
const MATCH_BRIEF_TURNS = 3;
/** 경기 다이제스트가 "방금 있었던 일"로 치는 기간 (일) */
const MATCH_DIGEST_DAYS = 3;
/** 계약 만료 임박 경고 창 (일) */
const EXPIRING_ALERT_DAYS = 180;

/**
 * 페르소나 블록 — 인물 카드를 모델이 읽는 형태로 (people.md §1).
 * 예시 대사까지 실어야 모델이 톤을 흉내 내는 대신 그 사람으로 말한다.
 * 세이브당 고정이라 레퍼런스 층(캐시 프리픽스)에 들어간다.
 */
export function describePersona(persona: Persona): string {
  return [
    `[${PERSONA_ROLE_LABEL[persona.role]} — 이 인물로 말할 때의 지침]`,
    `이름: ${persona.name} (${persona.archetype})`,
    `성격: ${persona.traits.join(" · ")}`,
    `동기: ${persona.motivation}`,
    `말투: ${persona.speechStyle.note}`,
    ...persona.speechStyle.samples.map((s) => `  예) ${s}`),
    // 직책이 아니라 이름으로 말한다 — 규칙은 시스템 프롬프트(출력 문법)에 한 번만 선다
    `화자 태그: @${persona.characterId}:`,
    // 실명 인물 — 평판을 해칠 서사 금지 가드와 세트로만 운용한다 (sources.md §7)
    ...(persona.real
      ? [
          `⚠️ 실존 인물이다. 직무 안에서 유능하게 그리고, 실제 인물의 평판을 해칠 서사 — 비위·불화·무능·사생활 — 는 만들지 않는다.`,
        ]
      : []),
  ].join("\n");
}

/**
 * 레퍼런스 블록 — 캐시되는 시스템 블록. 감독 프로필 + 인물 카드 + 선수 명부.
 * 능력치·컨디션은 넣지 않는다 — 상세는 조회 도구의 몫.
 * ⚠️ 정렬은 (포지션, id) 고정 — 훈련으로 바뀌는 값(OVR)으로 정렬하면 캐시 프리픽스가 매 턴 깨진다.
 */
export function buildGmReference(state: GameState): string {
  const rows = userPlayers(state)
    .map((p) => ({ p, pos: naturalPositionOf(p).position }))
    .sort((a, b) => (a.pos === b.pos ? (a.p.id < b.p.id ? -1 : 1) : a.pos < b.pos ? -1 : 1))
    .map(
      ({ p, pos }) =>
        `${p.id}|${p.name}|${pos}|${squadLevelOf(p) === "first" ? "1군" : "2군"}${p.isCaptain ? "|주장" : ""}`,
    );
  const m = state.manager;
  return [
    `[감독 프로필]`,
    `이름: ${m.name}`,
    `배경: ${m.background}`,
    `능력: 리더십${m.attributes.leadership} 전술${m.attributes.tactics} 훈련${m.attributes.training} 협상${m.attributes.negotiation} 분석${m.attributes.analysis}`,
    `평판: 보드${m.reputation.board} 미디어${m.reputation.media} 선수단${m.reputation.squad}`,
    `감독 발화 화자 형식: @${m.name}: <발화> — 당신은 이 화자를 대신 연기하지 않는다.`,
    ``,
    describePersona(headCoachOf(state)),
    ``,
    describePersona(ownerOf(state)),
    ``,
    // 기자단 카드 — 회견은 세계가 먼저 부르는 자리라, 부를 사람이 카드로 서 있어야 한다
    ...reportersOf(state).flatMap((r) => [describePersona(r), ``]),
    // ⚠️ 명부 헤더는 "모두 화자다"로 유지 — 조회 안내를 덧붙이면 명부가 id 표로
    // 읽혀 한 번 이름이 불린 선수만 계속 말한다
    `[${teamName(state.userTeamId)} 선수단] id|이름|주포지션|스쿼드 — 이 이름들이 모두 화자다`,
    ...rows,
  ].join("\n");
}

/** 유저의 자연어를 모델이 읽는 감독 화자 형식으로 감싼다. */
export function buildManagerMessage(state: GameState, message: string): string {
  return `@${state.manager.name}: ${message}`;
}

/**
 * 화면 조작 — 감독의 발화가 아니다. `@:`(화자 없음) 문법에 조작 그대로를 담아
 * (`@: [시간 진행 — 하루]`) GM이 대사로 읽고 인용·말투 추론하는 것을 막는다.
 */
export function buildOperatorMessage(message: string): string {
  return `@: [${message}]`;
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
    // 벤치에서 감독 옆에 서 있는 사람이다 — 경기 중 조언도 같은 사람의 말투여야 한다
    describePersona(headCoachOf(state)),
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
    .slice(0, 2)
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
export function buildGmStateNote(state: GameState, passed?: TimePassed | null): string {
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
    .slice(0, 3)
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
            .slice(0, 3)
            .map((row) => `${row.player.name}~${row.contract.until}`)
            .join(", ")}${expiring.length > 3 ? " …" : ""})`
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
    `재정: 잔고 £${(finance.balance / 1e6).toFixed(1)}M · 주급 £${(weeklyWagesOf(state, state.userTeamId) / 1e6).toFixed(2)}M/주 · 이적예산 £${(finance.transferBudget / 1e6).toFixed(1)}M`,
    // 부임 직후엔 선수단이 여름 휴가 중 — 소집일을 밝혀야 빈 훈련장을 지어내지 않는다
    state.date < squadReturnOf(state.calendar)
      ? `선수단 여름 휴가 중 — ${squadReturnOf(state.calendar)} 소집 (그 전에는 훈련을 잡을 수 없다)`
      : trainingCount > 0
        ? `예정 훈련 ${trainingCount}건: ${training.join(" / ")}${trainingCount > training.length ? " …" : ""}`
        : `예정 훈련 없음 — 기본 훈련까지 비워진 상태다`,
    alerts.length > 0 ? `주의: ${alerts.join(" · ")}` : `주의: 없음`,
    // 선수 근황 — 부상·정지·불만 밖의 이름이 실리는 유일한 자리.
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
        `이미 그날이다 — 첫 줄 헤더에 ${state.date}을(를) 적어라. 도구로 시간을 다시 옮기지 마라.`,
        passed.digest.length > 0
          ? `그 사이 벌어진 일 (하나를 골라 장면으로 열어라 — 목록으로 늘어놓지 마라):\n${passed.digest
              .map((d) => `- ${d}`)
              .join("\n")}`
          : `그 사이 특별한 일은 없었다.`,
      ].join("\n"),
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
    lines.push(
      `경기 뒤 들어온 소식 (하나를 골라 장면으로 열어라 — 목록으로 늘어놓지 마라):\n${news
        .map((n) => `- ${n}`)
        .join("\n")}`,
    );
  }
  // 채팅 턴 없는 화면 조작(전술판·명단·역할) — 이미 반영된 사실이라 모델은 반응만 한다
  const edits = state.pendingEdits ?? [];
  if (edits.length > 0) {
    lines.push(
      `감독이 화면에서 바꾼 것 (이미 반영됨 — 도구로 다시 하지 마라):\n${edits.map((e) => `- ${e.text}`).join("\n")}`,
    );
  }
  // 답을 기다리는 기자회견 — 이 줄이 없으면 모델은 회견이 열린 사실 자체를 모른다
  const press = describePendingPress(state);
  if (press) lines.push(press);
  // 협상은 있을 때만 — 없으면 한 줄도 쓰지 않는다 (매 턴 정가로 읽히는 블록이다)
  const negotiations = describeNegotiations(state);
  if (!negotiations.startsWith("진행 중인 협상 없음")) {
    lines.push(`협상:\n${negotiations}`);
  }
  const recent = state.narrative.slice(-4).map((n) => `${n.date} ${n.text}`);
  if (recent.length > 0) lines.push(`최근 사건: ${recent.join(" / ")}`);
  return lines.join("\n");
}

/**
 * 경기 장부 + 현재 판세 — 매 턴 갱신되는 휘발성 블록. 패킷도 여기(캐시 밖)에
 * 담되 JSON을 통째로 붓지 않고 캐스터가 실제로 읽는 것만 요약한다.
 *
 * `withPacket: false`는 **킥오프 턴**이다 — 아직 아무 일도 일어나지 않았는데
 * 판세를 쥐여 주면 첫 마디부터 우열을 읊는다. 그때 필요한 것은 대진과 선발뿐이다.
 */
export function buildLedgerNote(state: GameState, options: { withPacket?: boolean } = {}): string {
  const pending = state.pendingMatch;
  const ledger = pending?.ledger;
  if (!ledger || !pending) return "";
  const packet = options.withPacket === false ? null : pending.packet;
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
        packet.summary,
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
        // 공략 후보 — exploit_point는 이 목록의 id만 받는다 (없는 지점은 코어가 반려)
        ...(packet.targets.length > 0
          ? [
              `[공략 가능한 지점 — exploit_point로 겨냥한다, 동시에 ${MAX_EXPLOITS}곳까지]`,
              ...packet.targets.map((t) => `  ${t.id} — ${t.label}`),
              pending.exploits && pending.exploits.length > 0
                ? `지금 노리는 중: ${pending.exploits.join(", ")}`
                : `지금 노리는 곳 없음`,
            ]
          : []),
      ]
    : [];
  /**
   * **지금 내가 무엇을 걸어 뒀는가** — 되비추지 않으면 도구를 옳게 부를 수 없다.
   *
   * 경기 중에는 이 블록만 실리고 평시 스냅샷(6축이 적힌 줄)은 안 실린다. 그런데
   * `set_tactics`는 "현재 값과 다른 축만" 보내라 하고, `set_match_plan`은 동시
   * 두 곳까지이며, `set_player_tactic`은 "생략한 항목은 기존 값 유지"다 — 셋 다
   * 지금 값을 알아야 성립하는 규칙인데 그 값이 화면에 없었다. 그래서 "압박 올려"에
   * 모델이 숫자를 지어냈다.
   */
  const ourTactics = tacticsOf(state, state.userTeamId).spec;
  const assignments = tacticsOf(state, state.userTeamId).assignments.filter(
    (a) => a.role === "starting" && (a.directive || a.instruction || a.roleId),
  );
  const standingLines = [
    ``,
    `[지금 걸어 둔 것 — 바꾸려면 그 도구를 부른다]`,
    `전술 ${ourTactics.formation} · 멘탈${ourTactics.mentality} 라인${ourTactics.defensiveLine} ` +
      `압박${ourTactics.pressing} 템포${ourTactics.tempo} 폭${ourTactics.width} 패스${ourTactics.passStyle}` +
      ` (set_tactics — 감독이 말한 축만 바꾼다)`,
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
  // 사건은 싣지 않는다 — 구간은 감독 지시가 반영된 뒤 호출 안에서 advance_match가
  // 굴린다. 이 블록은 그 직전의 장부다
  return [
    `[경기 장부 — 매 턴 갱신]`,
    `스코어 ${ledger.score.home}:${ledger.score.away} · ${ledger.minute}′ · ${ledger.phase}`,
    `홈 온필드: ${withNames(ledger.home.onPitch)}`,
    `홈 벤치: ${withNames(ledger.home.bench)} (교체 ${ledger.home.subsUsed}/5, 기회 ${ledger.home.subWindows}/3)`,
    `어웨이 온필드: ${withNames(ledger.away.onPitch)}`,
    `어웨이 벤치: ${withNames(ledger.away.bench)} (교체 ${ledger.away.subsUsed}/5)`,
    ledger.sentOff.length > 0 ? `퇴장: ${withNames(ledger.sentOff)}` : "",
    ...standingLines,
    ...packetLines,
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

/** `AM 9:30` · `PM 7:05` → "HH:MM" (24시간) */
function toClock(meridiem: string | undefined, hour: string, minute: string): string {
  const h = Number(hour) % 12;
  const pm = /^(PM|오후|저녁|밤)$/i.test(meridiem ?? "");
  return `${String(pm ? h + 12 : h).padStart(2, "0")}:${minute}`;
}

/** 헤더가 가리키는 시각 — 시:분이 있으면 그것, 없으면 시간대의 기본값 */
function clockFromHeader(meridiem: string | undefined, hour?: string, minute?: string): string {
  if (hour && minute) return toClock(meridiem, hour, minute);
  return PART_OF_DAY[(meridiem ?? "").toLowerCase()] ?? "09:00";
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

/**
 * 대화 이력 창 — 시작점을 STEP 단위로만 옮긴다. 매 턴 한 칸씩 미끄러지면
 * 프리픽스가 계속 달라져 이력 캐시가 한 번도 적중하지 않는다.
 */
const HISTORY_KEEP = 12;
const HISTORY_STEP = 6;

/**
 * 평시와 경기의 이력을 가른다 — 섞이면 토큰만이 아니라 맥락이 오염된다
 * (경기 중 이력의 이적 이야기를 중계가 끌어온다). 두 국면은
 * buildMatchBrief·matchDigest가 잇는다.
 */
function relevantTurns(state: GameState): typeof state.chat {
  /**
   * 킥오프 멘트 턴은 아직 **라커룸의 연장**이다 — 경기 이력이 비어 있고 첫 마디를
   * 여는 근거는 경기 전 대화(팀토크·브리핑)다. 그래서 그 한 턴만 평시로 읽는다.
   */
  const inMatch = state.phase === "match" && state.pendingMatch?.entered === true;
  const here = state.pendingMatch?.matchId;
  return state.chat.filter((t) =>
    inMatch
      ? // 경기 중 — 이 경기의 턴만. 다른 경기의 중계도 남의 이야기다
        t.inMatch === true && (here === undefined || t.matchId === undefined || t.matchId === here)
      : t.inMatch !== true,
  );
}

export function buildGmHistory(
  state: GameState,
): Array<{ role: "user" | "assistant"; content: string }> {
  const chat = relevantTurns(state);
  const upto = Math.max(0, chat.length - 1); // 방금 push된 이번 발화는 제외
  const start = Math.max(
    0,
    Math.floor(Math.max(0, upto - HISTORY_KEEP) / HISTORY_STEP) * HISTORY_STEP,
  );
  return chat.slice(start, upto).map((turn) => ({
    // 오퍼레이터 지시도 user 역할로 간다(제공자 메시지는 user/assistant 교대다).
    // 갈리는 건 **내용의 형식**이다 — 감독 발화인지 조작인지를 본문이 밝힌다.
    role: turn.role === "model" ? ("assistant" as const) : ("user" as const),
    content:
      turn.role === "model"
        ? turn.text
        : turn.role === "operator"
          ? buildOperatorMessage(turn.text)
          : buildManagerMessage(state, turn.text),
  }));
}
