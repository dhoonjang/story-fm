import { CALL_LABELS } from "@story-fm/domain";

export type SkillGroup = "진행" | "전술·훈련" | "대화·서사" | "조회" | "재정";

export interface SkillCatalogEntry {
  name: string;
  label: string;
  group: SkillGroup;
  readOnly: boolean;
  description: string;
}

/**
 * 모델에 제공하는 도구 설명의 코드 기본값과 어드민 표시 메타데이터.
 *
 * 한 도구의 사용법은 여기에만 산다 — 언제 부르고, 인자를 어떻게 채우고, 결과를
 * 장면에 어떻게 옮기는가. `GM_SYSTEM`은 도구와 무관한 규칙만 갖는다
 * (docs/common/llm/prompts.md §5). 경기 스킬은 match-gm의 별도 카탈로그에 산다.
 */
export const SKILL_CATALOG = [
  {
    name: "start_negotiation",
    label: CALL_LABELS.start_negotiation,
    group: "대화·서사",
    readOnly: false,
    description:
      "이적·자유계약·재계약의 새 협상 또는 진행 중인 협상을 연다. 제안 요청도 이 도구로 해당 화면을 연다. 새 협상의 첫 문구는 감독이 편집할 제안이며 발송되지 않는다. 메인 GM은 제안 발송·동의·서명을 수행하지 않는다.",
  },
  {
    name: "set_transfer_list",
    label: CALL_LABELS.set_transfer_list,
    group: "대화·서사",
    readOnly: false,
    description:
      "우리 구단 선수를 이적 명단에 등록하거나 해제한다. 선수 이름 또는 실제 id, listed 여부와 감독이 정한 정수 £ 희망 이적료 askingPrice를 전달한다. 가격을 지정하지 않으면 기존 값을 유지한다. 명단 등록은 제안·매각·동의가 아니다.",
  },
  {
    name: "get_negotiations",
    label: CALL_LABELS.get_negotiations,
    group: "조회",
    readOnly: true,
    description:
      "협상 목록의 진행·답변 대기·현재 제안과 다음 행동을 간결하게 조회한다. 대화 원문은 메인 채팅에 복제하지 않는다.",
  },
  {
    name: "release_staff",
    label: CALL_LABELS.release_staff,
    group: "대화·서사",
    readOnly: false,
    description:
      "감독이 우리 구단 스태프를 명시적으로 해고했을 때 그 사람의 재직을 종료한다. name은 감독이 부른 이름 그대로다. 잔여 계약 위약금(연봉 1년치 상한)이 구단 원장에 지출로 남고, 현금이 모자라면 반려된다. 불만·경고·해고 고민은 해고가 아니다. 해고된 사람은 스태프 풀로 돌아가 같은 시즌 안에 다시 고용할 수 있다.",
  },
  {
    name: "accept_manager_offer",
    label: CALL_LABELS.accept_manager_offer,
    group: "대화·서사",
    readOnly: false,
    description:
      "감독이 이 제안의 현재 조건을 명시적으로 수락했을 때만 실행한다. 제안 생성·조건 흥정은 수락이 아니다.",
  },
  {
    name: "counter_manager_offer",
    label: CALL_LABELS.counter_manager_offer,
    group: "대화·서사",
    readOnly: false,
    description:
      "대화에서 구단이 동의해 제시한 수정 조건을 기록한다. 감독의 요구만으로 상대 승인을 만들지 않는다. 수정은 유저 수락이 아니며 횟수·인상률 제한은 없다.",
  },
  {
    name: "apply_manager_job",
    label: CALL_LABELS.apply_manager_job,
    group: "대화·서사",
    readOnly: false,
    description:
      "감독이 공석인 구단에 지원하겠다고 명시했을 때 그 구단과 감독직 면접을 연다. team은 구단 id·이름·약칭이다. 최근 공석이 아닌 구단이면 반려되고 지금 지원할 수 있는 공석 목록이 온다. 같은 구단의 면접이 이미 열려 있거나 경기 중이면 반려된다. 면접의 결과는 respond_to_interview가 기록한다.",
  },
  {
    name: "tactic_orders",
    label: CALL_LABELS.tactic_orders,
    group: "전술·훈련",
    readOnly: false,
    description:
      "감독이 판을 세우는 지시를 했을 때 — 라인업·1·2군 이동·팀 전술 6축과 갈래·선수의 자리·역할·세트피스 키커와 인원·승부차기 순서·완장. " +
      "인자 없이 한 턴에 한 번 부른다 — 이번 턴 감독 발화 원문을 코어가 해석하고 적용·반려 결과를 돌려준다. " +
      "미반영 지시와 필요한 결정을 이번 장면에서 감독에게 알린다. " +
      '감독이 정하지 않고 맡긴 말("알아서 짜세요")에는 부르지 않는다 — 코치의 안을 장면으로 내놓고 감독이 못 박은 턴에 부른다. ' +
      "맨마킹·공간 공략 같은 실행 지시는 경기 중에만 걸린다. 훈련·육성은 training_orders, 재정은 finance_orders다.",
  },

  {
    name: "training_orders",
    label: CALL_LABELS.training_orders,
    group: "전술·훈련",
    readOnly: false,
    description:
      "감독이 훈련이나 육성을 지시했을 때 — 훈련 일정 등록·비우기·개인 훈련·집중 육성·유스 첫 계약. " +
      "인자 없이 한 턴에 한 번 부른다 — 이번 턴 감독 발화 원문을 코어가 해석한다. 결과로 무엇이 걸렸고 무엇이 반려됐는지가 온다. " +
      "라인업·전술은 tactic_orders다.",
  },

  {
    name: "set_squad_number",
    label: CALL_LABELS.set_squad_number,
    group: "전술·훈련",
    readOnly: false,
    description:
      "감독이 우리 선수에게 등번호를 정해 줬을 때 부른다. playerId는 감독이 부른 선수, number는 감독이 말한 번호다. " +
      "그 번호를 동료가 달고 있으면 반려되고 답에 그 동료가 온다 — 감독에게 알리고, 감독이 넘겨주라고 하면 take: true로 다시 부른다.",
  },

  {
    name: "finance_orders",
    label: CALL_LABELS.finance_orders,
    group: "재정",
    readOnly: false,
    description:
      "감독이 티켓 가격을 바꾸라고 지시했을 때 부른다. 인자 없이 한 턴에 한 번 부른다 — 이번 턴 감독 발화 원문을 코어가 해석해 표값을 바꾸고 적용·반려 결과를 돌려준다. 실제 폭은 코어가 기준가 대비로 자른다. 구장 증설 요청과 결정은 request_board다.",
  },

  {
    name: "request_board",
    label: CALL_LABELS.request_board,
    group: "재정",
    readOnly: false,
    description:
      "보드 재정 요청을 접수하거나 requestId로 열린 안건의 결정을 기록한다. GM이 맥락을 읽고 decision(approved·rejected·conditional)·authorizedBy(현재 구단주 ID)·granted·respondOn과 조건·deliversOn을 정한다. pending은 자동 판정되지 않는다. 요청량과 승인량은 좌석 수다. 원장이 반려한 금액을 승인된 것으로 말하지 않는다.",
  },
  {
    name: "hire_staff",
    label: CALL_LABELS.hire_staff,
    group: "대화·서사",
    readOnly: false,
    description:
      "감독과 당사자가 합의한 스태프 고용·재계약을 기록한다. name·salary(연봉 £)·until(만료일)을 명시한다. 풀 밖 사람은 role·title·lorebook을 함께 제공한다. 기존 재직자는 같은 이름으로 갱신하며 급여·기한을 자동 결정하지 않는다. 제안만으로 체결하지 않는다.",
  },
  {
    name: "start_match",
    label: CALL_LABELS.start_match,
    group: "진행",
    readOnly: false,
    description:
      "경기일에 킥오프를 준비한다. 감독이 들어가자고 할 때, 또는 경기 전 점검(라인업·전술·팀토크)이 끝나 " +
      "그날 남은 일이 경기뿐일 때 되묻지 말고 부른다. " +
      "성공하면 이번 턴이 이 호출로 끝나고 장면을 쓰지 않는다. 같은 턴에 필요한 다른 호출은 먼저 부른다.",
  },
  {
    name: "review_board",
    label: CALL_LABELS.review_board,
    group: "대화·서사",
    readOnly: false,
    description:
      "구단의 실제 감독 경질·선임을 실행한다. action=dismiss는 재직을 종료하고, appoint는 공석에 AI 감독을 선임한다. team·reason을 적고 선임은 managerName과 새 인물의 rating을 지정한다. 풀의 감독은 기존 역량과 이력을 유지한다. 유저 감독의 부임은 제안과 명시적 수락을 거친다.",
  },
  {
    name: "offer_manager_job",
    label: CALL_LABELS.offer_manager_job,
    group: "대화·서사",
    readOnly: false,
    description:
      "구단이 실제로 제시한 감독 계약을 기록한다. team·salary·years·expiresOn·reason을 명시한다. 현재 구단은 재계약, 다른 공석은 부임·접근 제안이다. 유저의 수락을 대신하지 않는다. 같은 구단의 열린 제안 수정은 counter_manager_offer를 사용한다.",
  },
  {
    name: "set_retirement",
    label: CALL_LABELS.set_retirement,
    group: "대화·서사",
    readOnly: false,
    description:
      "선수가 결정한 은퇴 선언 또는 철회를 기록한다. declare는 playerId와 reason(age·decline·idle·personal·injury), withdraw는 playerId를 적는다. 나이·출장·능력만으로 선언을 자동 판정하지 않는다. 선언은 시즌 종료 때 집행된다.",
  },
  {
    name: "respond_to_interview",
    label: CALL_LABELS.respond_to_interview,
    group: "대화·서사",
    readOnly: false,
    description:
      "열린 감독직 면접에서 채용 제안 여부와 계약 조건을 판정한다. 여러 구단과 면접 중이면 interviewId 또는 team(구단 id·이름·약칭)으로 대상을 지정한다. 면접이 하나면 생략할 수 있다. offer와 reason을 적고, 제안이면 terms에 salary·years·expiresOn을 명시한다. 제안은 감독의 수락이 아니다. 감독이 답한 내용과 구단 사정에 근거하며.",
  },
  {
    name: "update_character",
    label: CALL_LABELS.update_character,
    group: "대화·서사",
    readOnly: false,
    description:
      "대화와 사건으로 캐릭터에 기록할 내용이 생겼을 때 로어북 갱신을 접수한다. characterId는 항목 id 또는 이름, additionalInformation은 새로 드러난 사정·행동·기억·관점이다. 이름을 바꾸지 않는다. 처음 등장한 인물은 newCharacter에 이름·키워드·한 줄 설명·정보를 함께 적는다. 편집은 비동기로 진행되며 접수만으로 완료됐다고 말하지 않는다.",
  },
  {
    name: "apply_finance_event",
    label: CALL_LABELS.apply_finance_event,
    group: "재정",
    readOnly: false,
    description:
      "서사에서 벌어진 매출·비용을 장부에 남긴다 — 스폰서가 보너스를 얹거나(commercial), 유니폼이 동나거나(merchandising), 관중이 몰리거나(matchday), 시설이 망가지거나(facility), 원정 의료비가 들거나(travel_medical), 선수단에 포상을 주는(bonus) 일. " +
      "경기 운영비는 matchday_opex. 중계권·주급·상각·대회 상금은 코어가 계산하므로 이 도구로 건드릴 수 없다. " +
      "대화에서 확정된 지급 원인과 실제 금액을 기록한다. 원장에 들어가 잔고·월간 보고서·급여 비중에 반영된다.",
  },
  {
    name: "resign",
    label: CALL_LABELS.resign,
    group: "진행",
    readOnly: false,
    description:
      "감독이 계약을 마치기 전에 떠난다 — 계약 잔여에 따른 위약금은 구단 장부와 커리어 기록에 남는다. " +
      "감독이 명확히 사임하겠다고 말했을 때만 부른다. 불만·이직 고민은 사임이 아니다. " +
      "부르면 무직이 되고 되돌릴 수 없다.",
  },
  {
    name: "search_players",
    label: CALL_LABELS.search_players,
    group: "조회",
    readOnly: true,
    description:
      '포지션·이름·나이·가용 상태에 계약 잔여·주급·홈그로운·성장 가능성·주발까지 걸어 찾는다. team="mine"은 우리 팀, 팀 id·이름은 특정 팀. ' +
      "team을 생략하면 풀이 5대 리그 1·2부 전체이므로, 우리 리그 안에서 비교할 때는 competition(epl 등)으로 좁힌다. " +
      'squadLevel="reserve"는 2군 유망주. 조건은 도구가 걸어라 — limit만큼 훑어 고르지 마라. ' +
      "sortBy는 age·fatigue·contract만 낮은 쪽이 앞이다. " +
      "우리 선수는 정확한 정보, 타 팀 선수는 지식 수준에 따른 평가와 계약 만료일을 준다. " +
      "playerId를 주면 능력치·컨디션·계약·배치에 부상 이력과 이번 시즌 경고 누적·이동 이력, 이번 시즌과 지난 시즌의 대회별 기록(리그·컵·대항전 각각 몇 경기 몇 골)까지 붙은 상세 카드가 나온다 — 감독이 특정 선수를 두고 물으면 그 선수를 논하기 전에 먼저 호출한다.",
  },
  {
    name: "get_squad",
    label: CALL_LABELS.get_squad,
    group: "조회",
    readOnly: true,
    description:
      "우리 팀의 현재 배치를 본다 — 포메이션·팀 전술과 선발 11명·벤치·예비(배치 없음)를 자리 순서대로, " +
      "각자의 자리 적합도·포지션 적응도·전술 적응도·폼·체력과 부상·정지·경고 누적까지. " +
      'level="reserve"면 2군, role="starting"이면 선발만 본다. ' +
      "라인업·포지션·교체를 논하기 전에 호출한다. 타 팀 스쿼드는 볼 수 없다 — 상대 전력은 get_team으로.",
  },
  {
    name: "get_team",
    label: CALL_LABELS.get_team,
    group: "조회",
    readOnly: true,
    description:
      "팀의 순위·전적·전술·최근 경기·주요 선수를 조회한다. 다음 상대를 브리핑하거나 감독이 다른 팀을 물을 때 사용한다.",
  },
  {
    name: "get_league",
    label: CALL_LABELS.get_league,
    group: "조회",
    readOnly: true,
    description:
      'view="standings" 순위표(competition으로 다른 리그·대항전도) — 행마다 최근 5경기 폼이 붙고, split="home"·"away"면 홈·원정 소계로 다시 세운 표다. 국내 컵은 대진표가 온다. ' +
      'view="leaders" 그 대회의 개인 순위(득점·도움·평점·클린시트·징계 상위 10 · key로 한 축만)와 팀 열(득점·실점·무실점·슛·xG). 리그·국내 컵·대항전 모두 선다. ' +
      'view="fixtures" 일정 검색 — team(기준 팀, 생략하면 우리 팀, "all"이면 대회 전체), opponent(맞대결만 · 전적 요약), competition, when(past·upcoming·both), from·to, round, count. ' +
      'view="calendar" 감독의 달력 — 경기·훈련·컵 추첨을 날짜순으로. 기본 오늘부터 14일이고 from·to·days로 범위를, type="training"으로 훈련만 본다. 새 훈련을 잡기 전에 이걸로 확인하라. from이 지난 날이면 그 사이 벌어진 일이 일지로 함께 온다.',
  },
  {
    name: "get_match_report",
    label: CALL_LABELS.get_match_report,
    group: "조회",
    readOnly: true,
    description:
      "끝난 경기 하나를 통째로 읽는다 — 타임라인(골의 원인 태그 포함)·팀 스탯(점유·슛·xG·기대 득점·패스·코너·파울·카드)·선수별 기록·평점과 그 한 줄 근거·MOTM. " +
      "감독이 지난 경기의 내용·패인·누가 잘했는지를 물으면 스코어만 들고 답하지 말고 이걸 부른다. " +
      "경기는 opponent(상대 팀 이름·약칭)·competition(epl·ucl·facup 등)·date(YYYY-MM-DD)로 고르고, 아무것도 주지 않으면 가장 최근에 끝난 우리 경기다. matchId를 알면 그것만 준다.",
  },
  {
    name: "get_opponent_report",
    label: CALL_LABELS.get_opponent_report,
    group: "조회",
    readOnly: true,
    description:
      "다음 경기 상대를 경기 전에 읽는다 — 예상 XI(상대의 직전 경기 선발에서 투영)·결장자(부상·정지)·상대 모양과 전술 6축·감독이 읽어 낸 지점(전술 상성과 미스매치). " +
      '감독이 경기 전에 상대를 묻거나("쟤네 어떻게 나와") 누굴 노릴지·누굴 세울지 상의하면 순위와 최근 5경기만 들고 답하지 말고 이걸 부른다. ' +
      "지점 줄의 +는 우리에게 이로운 것, -는 상대에게 이로운 것이다. " +
      "경기는 opponent(상대 팀 이름·약칭)·competition(epl·ucl·facup 등)·date(YYYY-MM-DD)로 고르고, 아무것도 주지 않으면 다음 우리 경기다. " +
      "예상 XI는 예상이다 — 상대가 로테이션을 돌리면 갈리므로 확정으로 말하지 않는다. 경기 중에는 부를 수 없다(판세 화면이 지금 판을 들고 있다).",
  },
  {
    name: "get_career",
    label: CALL_LABELS.get_career,
    group: "조회",
    readOnly: true,
    description:
      "감독의 커리어 — 이번 시즌 진행 상황, 지난 시즌들의 순위·전적, 트로피, 업적, 맡은 팀이 받은 시상. " +
      "지나간 시즌의 순위표·우승자·감독 팀의 경기는 get_history가 낸다.",
  },
  {
    name: "get_history",
    label: CALL_LABELS.get_history,
    group: "조회",
    readOnly: true,
    description:
      "지나간 시즌의 장부를 읽는다. season으로 그 시즌의 우승자와 우리 성적을, season+competition으로 그 시즌 그 대회의 최종 순위표(녹아웃은 우승·준우승)를 본다. " +
      'team이면 그 구단의 역대 — 우승 횟수·한 시즌 최다 승점·최다 득점·최고 순위·그 구단 소속의 시상. player면 그 선수의 통산·팀별·시즌별 기록과 받은 상(은퇴한 선수도 찾는다) — 시즌 줄이 대회별로 갈리므로 "작년 챔스에서 몇 골"이 여기서 답이 된다. ' +
      "competition만 주면 그 대회의 역대 우승이 시즌마다 한 줄로 온다. 아무것도 주지 않으면 지나간 시즌 목록이 최근부터 온다. " +
      "지난 시즌을 두고 순위·우승·구단 역사·역대 최다를 물으면 지어내지 말고 이걸 부른다. " +
      "장부에 남은 지난 시즌 경기는 감독 팀의 것뿐이다 — 남의 팀끼리의 지난 시즌 스코어는 없고, 없는 것은 없다고 답한다.",
  },
  {
    name: "get_finance",
    label: CALL_LABELS.get_finance,
    group: "조회",
    readOnly: true,
    description:
      '구단 재정을 조회한다 — 잔고·주급 총액·부채·1년 안에 끝나는 계약 전원(만료되면 무소속으로 떠난다), 월간 보고서(수입·지출, 현금 순증과 장부 손익, 급여 비중), 이번 달 잠정 집계. month를 주면 그 달 보고서만 본다("2026-08").',
  },
] as const satisfies readonly SkillCatalogEntry[];

export type SkillName = (typeof SKILL_CATALOG)[number]["name"];
export type SkillDescriptions = Record<SkillName, string>;

export const SKILL_NAMES = SKILL_CATALOG.map((skill) => skill.name);

export const DEFAULT_SKILL_DESCRIPTIONS = Object.fromEntries(
  SKILL_CATALOG.map((skill) => [skill.name, skill.description]),
) as SkillDescriptions;

/** 이번 LLM 턴에 실릴 도구 설명 — 코드가 유일한 원본이다 (prompts.md §2). */
export function skillDescriptions(): SkillDescriptions {
  return DEFAULT_SKILL_DESCRIPTIONS;
}
