import type { MatchEvent, ShootoutKick, ShootoutOutcome, StrengthPacket } from "@story-fm/domain";
import { packetTagText, subCauseText } from "@story-fm/domain";

/**
 * 매치 캐스터 — 경기 장면의 GM. 사건은 코어가 xg로 이미 확정하고
 * 캐스터는 그것을 중계·연출·대화로 옮긴다 — **결과를 바꿀 도구가 없다** (match.md).
 * 감독의 말은 앞 호출(지시 해석)이 이미 옮겼고 구간도 코어가 굴려 두었으므로,
 * 이 호출이 받는 것은 확정된 사건과 **그 턴에 갱신된 패킷**이다 (agents.md §3).
 * 프롬프트는 코드처럼 버전 관리한다 (AGENTS.md 6-5).
 */
export const MATCH_CASTER_SYSTEM = `당신은 스토리 기반 풋볼 매니저의 경기 중계자다. 축구 경기를 중계하고, 벤치의 대화를 연출한다.

# 정지점의 주인 (다른 무엇보다 먼저 지킨다)
- **정지점은 감독의 차례다.** 감독의 대사·판단·지시를 대신 쓰지 않는다. 감독을
  화자로 세우지 않는다 — 감독 이름으로 시작하는 줄을 쓰지 마라.
- **팀 토크와 개인 면담은 감독이 말과 강도를 고르는 자리다.** 감독이 선수를 부르기만
  했으면 그 선수를 데려오는 데까지가 당신 몫이고, 선수의 대답까지만 쓴다.
- **한 턴은 한 호흡이다.** 받은 사건을 중계했으면 거기서 끝낸다. 수석코치의 짧은
  관찰이나 벤치의 반응으로 장면을 닫고 감독에게 넘긴다.
- **골·퇴장·부상은 그 장면에서 끝낸다.** 하프타임은 라커룸 장면 하나로 연다.

# 가장 중요한 규칙
**경기에서 일어난 일은 이미 정해져 있다.** [이번 구간에 일어난 일]이 사건 목록이다.
당신의 일은 그 사건을 **빠뜨리지 않고, 더하지 않고** 생생한 중계로 옮기는 것이다.
- 목록에 없는 골·슛·찬스·카드·부상·교체를 만들지 마라. 목록에 있는 것을 빼지도 마라.
- **\`(진행 없음)\`인 턴에는 경기 진행이 없다.** 공이 멈춘 그 자리의 대화와 분위기만 쓴다 —
  슛도 찬스도 없다. 시간은 한 순간도 흐르지 않았다.
- 스코어는 주어진 장부가 유일한 진실이다. 당신이 계산하지 않는다.
- 사건 사이의 흐름·분위기·관중·벤치 반응은 당신의 재량이다. 그 여백에서 이야기를 만들어라.
- 사건에 붙은 원인(전력 분석 패킷 인용)이 있으면 중계의 근거로 그 문장을 살려라.
- **감독이 방금 내린 지시는 이미 판에 올라 있다** — [감독의 지시에 코어가 답한 것]과
  판세의 전술 노트가 그 결과다. 걸린 지시도, 걸리지 않은 지시도 그대로 중계의 근거다.

# 출력 문법 (반드시 준수)
- **시각 줄을 쓰지 마라.** 경기 시각의 주인은 장부이고, 첫 줄은 코어가 붙인다.
- 화자 발화는 \`@중계:\` \`@손흥민:\` 처럼 시작한다. 중계만 역할 태그를 쓰고,
  사람은 **이름**으로 말한다 — 수석코치도 인물 카드의 이름을 태그로 쓴다.
  선수 화자는 반드시 한글 이름 — id 금지.
- 화자 없는 내레이션은 \`@:\` 로 시작한다. 행동·연출은 *별표*.
- 모든 텍스트 줄은 @로 시작한다. 문법 밖 텍스트를 쓰지 마라.
- 중계·대사에서 선수는 항상 이름으로 부른다. id를 그대로 옮겨 쓰지 마라.
- **완성된 중계만 쓴다.** 생각을 정리하는 과정, 검토했다가 버린 전개, 작업 방식에
  대한 언급은 출력에 넣지 않는다. \`<thinking>\` 같은 내부 태그도 쓰지 않는다.

# 철칙
1. 사건 목록과 경기 장부, 전력 분석 패킷만 근거로 삼는다. 없는 선수·사건·우열을 지어내지 마라.
2. 감독이 무엇을 지시해도 **이번 구간의 결과는 바뀌지 않는다.**
   "지시대로 곧바로 골이 터졌다"처럼 쓰지 마라.
3. 전력 우위는 경향이지 결과가 아니다. 약팀이 앞서고 있으면 그 사실을 그대로 중계하라.
4. 실제 축구의 리듬을 지켜라. 사건 하나를 몇 줄로 늘려 쓰지 않는다.
5. 구간이 굴렀는데 조용했다면(\`(사건 없음)\`) 짧게 흐름만 전한다. 억지로 사건을 만들지 마라.

# 첫 턴 — 킥오프
**[이번 구간에 일어난 일]이 아예 오지 않은 턴**이 경기의 첫 턴이다. 진행이 없다고
적힌 턴(\`(진행 없음)\`)은 첫 턴이 아니라 감독이 말만 건 턴이다.
- 경기장·대진·선발을 훑고 **첫 휘슬까지만** 쓴다.
- 슛·골·파울·교체를 쓰지 마라.
- 이력에 경기 전 대화(팀토크·브리핑)가 있으면 그 목소리에서 이어 연다.
- 마지막 줄은 감독의 차례로 넘긴다.

# 진행
- 한 턴은 주어진 구간 하나다.
- 구간이 골·퇴장·부상으로 끝났으면 그 장면을 정점으로 삼아라.
- 하프타임·경기 종료는 그에 맞는 마무리를 붙인다.
- 분량은 4~10줄.

# 대화
- 감독은 수석코치·벤치 선수와 대화할 수 있다. 그라운드 위 선수에게 한 말은 연출로만 전달한다.
- 수석코치의 조언은 패킷과 장부를 근거로 한다. 전술 지시의 **대가**를 필요하면 짚어 준다.
- 레퍼런스에 인물 카드가 주어진 화자는 **그 카드의 성격·말투 그대로** 말한다.

# 언어
한국어. 국내 축구 중계의 관용 표현을 쓴다. 하이라이트 위주로 리듬감 있게.
화자는 게임 내부의 수치를 입에 담지 않는다 — 능력치·전력 점수·소화율·확률.
"pace 88" 대신 "리그 최고 수준의 스피드", "소화율 68%" 대신 "지시가 아직 덜 붙었습니다".`;

/** 킥오프 턴 유저 메시지 — 패킷 + 감독의 사전 지시 */
export function buildKickoffMessage(packet: StrengthPacket, managerNote?: string): string {
  const note = managerNote ? `\n\n[감독의 경기 전 지시]\n${managerNote}` : "";
  return (
    `아래 전력 분석 패킷을 근거로 경기를 시작하라. 킥오프부터 첫 정지점까지 진행한다.` +
    `\n\n[전력 분석 패킷]\n${JSON.stringify(packet, null, 2)}${note}`
  );
}

/** 진행 턴 유저 메시지 — 장부 스냅샷 + 감독 발화 */
export function buildContinueMessage(ledgerSummary: string, managerInput: string): string {
  return `${ledgerSummary}\n\n[감독]\n${managerInput}`;
}

const EVENT_KO: Record<MatchEvent["type"], string> = {
  kickoff: "킥오프",
  goal: "골",
  shot: "슛(무득점)",
  save: "선방",
  chance: "찬스 무산",
  foul: "파울",
  yellow_card: "경고",
  red_card: "퇴장",
  substitution: "교체",
  injury: "부상",
  half_time: "하프타임",
  extra_time_start: "연장 돌입",
  extra_half_time: "연장 하프타임",
  full_time: "경기 종료",
};

const STOP_KO: Record<string, string> = {
  goal: "골이 터져 흐름이 끊겼다",
  red_card: "퇴장으로 경기가 멈췄다",
  injury: "부상으로 경기가 멈췄다",
  half_time: "전반이 끝났다 — 라커룸 장면",
  extra_time_start: "90분이 승부를 못 가렸다 — 연장으로 간다",
  extra_half_time: "연장 전반이 끝났다",
  full_time: "경기가 끝났다 — 마무리 중계",
  flow: "특별한 사건 없이 시간이 흘렀다",
  shootout_start: "120분이 승부를 못 가렸다 — 승부차기로 간다",
  shootout_kick: "승부차기 한 발이 끝났다 — 다음 키커가 준비한다",
  /** 진행 정지점이 아니라 승부차기의 끝 — 승부가 갈린 자리다 (`shootoutSettled`) */
  shootout_done: "승부차기가 끝났다 — 승부가 갈렸다",
};

const SHOOTOUT_OUTCOME_KO: Record<ShootoutOutcome, string> = {
  scored: "성공",
  saved: "골키퍼 선방",
  missed: "골문을 벗어났다",
};

/**
 * 사건의 배우 표기. `actors` 순서는 사건 종류마다 다른 방향을 뜻하므로(골은
 * [득점자, 도움], 교체는 [아웃, 인] — match.md §4) 순서에 뜻을 맡기지 않고
 * 역할을 이름 옆에 적는다.
 */
function actorsNote(ev: MatchEvent, nameOf: (id: string) => string): string {
  const [first, second] = ev.actors.map(nameOf);
  if (!first) return "";
  if (ev.type === "goal") return second ? `득점 ${first} · 도움 ${second}` : `득점 ${first}`;
  if (ev.type === "substitution") return second ? `OUT ${first} · IN ${second}` : `OUT ${first}`;
  return ev.actors.map(nameOf).join(" → ");
}

/** 구간 대본 → 캐스터 입력. 선수는 이름으로 준다 — id를 주면 중계에 id가 흘러나온다. */
export function buildSegmentMessage(
  events: MatchEvent[],
  stop: string,
  nameOf: (id: string) => string,
  sideName: (side: "home" | "away") => string,
): string {
  const lines = events.map((ev) => {
    const who = actorsNote(ev, nameOf);
    const team = ev.team ? `${sideName(ev.team)} ` : "";
    /** 교체의 갈래는 `subCause`가, 골의 근거는 패킷 태그가 갖는다 (match.md §4) */
    const reasons = [
      ...(ev.subCause ? [subCauseText(ev.subCause)] : []),
      ...ev.causes.map((tag) => packetTagText(tag)),
    ];
    const cause = reasons.length > 0 ? ` · 근거: ${reasons.join(" / ")}` : "";
    const detail = ev.detail ? ` · ${ev.detail}` : "";
    return `- ${ev.minute}′ ${team}${EVENT_KO[ev.type]}${who ? `: ${who}` : ""}${cause}${detail}`;
  });
  return [
    "[이번 구간에 일어난 일 — 이대로 중계하라]",
    lines.length > 0 ? lines.join("\n") : "- (사건 없음)",
    "",
    `[구간 종료] ${STOP_KO[stop] ?? stop}`,
  ].join("\n");
}

/**
 * 승부차기 한 발의 대본 — 선수는 이름으로 준다(id를 주면 중계에 id가 샌다).
 *
 * 킥을 굴리는 것은 코어이고 이 함수가 하는 일은 **확정된 한 발을 문장으로 옮기는
 * 것**뿐이다 — 다른 정지점과 같은 분업이다 (match.md §2). 킥의 성공 확률은 싣지
 * 않는다: 화자가 입에 담지 않는 게임 내부 수치다.
 *
 * 아직 한 발도 굴리지 않은 턴(`kick`이 `null`)은 감독이 **키커 순서를 정할
 * 자리**이므로 대본이 그 사실을 밝힌다.
 */
export function buildShootoutMessage(
  kick: ShootoutKick | null,
  tally: { home: number; away: number },
  done: boolean,
  nameOf: (id: string) => string,
  sideName: (side: "home" | "away") => string,
): string {
  const tallyLine = `합계 ${sideName("home")} ${tally.home} : ${tally.away} ${sideName("away")}`;
  const lines = kick
    ? [
        `- ${kick.round}번째 키커 · ${sideName(kick.team)} ${nameOf(kick.taker)}` +
          (kick.keeper ? ` ↔ 골키퍼 ${nameOf(kick.keeper)}` : "") +
          ` · ${SHOOTOUT_OUTCOME_KO[kick.outcome]} · ${tallyLine}`,
      ]
    : ["- (이번 턴에 찬 발은 없다 — 감독이 키커 순서를 정할 자리다)", `- ${tallyLine}`];
  const stop = done ? "shootout_done" : kick ? "shootout_kick" : "shootout_start";
  return [
    "[이번 구간에 일어난 일 — 이대로 중계하라]",
    lines.join("\n"),
    "",
    `[구간 종료] ${STOP_KO[stop] ?? stop}`,
  ].join("\n");
}

/**
 * 진행이 없는 턴의 대본 — **대화 턴과 킥오프 턴을 입력에서 가른다.**
 *
 * 대화만 건 턴은 구간을 굴리지 않아 사건 목록도 패킷도 없었고, 그래서 킥오프 턴과
 * 겉모습이 같았다. 프롬프트의 "첫 턴"과 "시간이 흐르지 않은 턴"이 같은 입력을 두고
 * 갈리면서 캐스터는 지나가지도 않은 12분과 있지도 않은 슛을 중계했다. 이 블록이
 * 오면 대화 턴이고, 아예 오지 않으면 첫 턴이다.
 */
export function buildNoSegmentMessage(minute: number): string {
  return [
    "[이번 구간에 일어난 일 — 이대로 중계하라]",
    `- (진행 없음 — 감독이 말만 건 턴이다. 공은 ${minute}′에 멈춰 있다)`,
    "",
    "[구간 종료] 시간이 흐르지 않았다",
  ].join("\n");
}
