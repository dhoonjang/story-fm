import { MAX_INCIDENTS_PER_DAY } from "@story-fm/engine";
import {
  INCIDENT_KIND_KO,
  INCIDENT_KINDS,
  MISSION_CANDIDATES,
  MISSION_DAYS,
} from "@story-fm/domain";

export type SkillGroup = "진행" | "전술·훈련" | "대화·서사" | "조회" | "이적" | "재정";

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
 * (docs/llm/prompts.md §5). 경기 중에는 이 설명이 실리지 않으므로 경기에서도 필요한
 * 판정 근거는 `TACTIC_ORDERS_SYSTEM`이 따로 갖는다 — 그 겹침은 중복이 아니다.
 */
export const SKILL_CATALOG = [
  {
    name: "start_match",
    label: "경기 시작",
    group: "진행",
    readOnly: false,
    description:
      "경기일에 킥오프를 준비한다. 감독이 들어가자고 할 때, 또는 경기 전 점검(라인업·전술·팀토크)이 끝나 " +
      "그날 남은 일이 경기뿐일 때 되묻지 말고 부른다. " +
      "부르면 감독에게 입장 확인 창이 뜨므로 이 턴에는 경기장으로 향하는 장면까지만 쓰고 킥오프·중계는 쓰지 않는다. " +
      "감독이 입장하면 경기 마스터가 진행한다.",
  },
  {
    name: "tactic_orders",
    label: "전술 지시",
    group: "전술·훈련",
    readOnly: false,
    description:
      "감독이 판을 세우는 지시를 했을 때 — 라인업·1·2군 이동·팀 전술 6축과 갈래·선수의 자리·역할·개인 지시·세트피스 키커와 인원·지역 플랜·약점 공략·완장. " +
      "orders에 감독의 말을 원문 그대로 적는다 — 요약하지 않는다. 결과로 무엇이 걸렸고 무엇이 반려됐는지가 온다. 반려된 대로 쓴다. " +
      "훈련·육성은 training_orders, 이적·재정은 market_orders다. 회견·면담은 각자의 도구가 있다.",
  },
  {
    name: "training_orders",
    label: "훈련 지시",
    group: "전술·훈련",
    readOnly: false,
    description:
      "감독이 훈련이나 육성을 지시했을 때 — 훈련 일정 등록·비우기·개인 훈련·집중 육성·멘토링·2군 훈련 방침·등번호·유스 첫 계약. " +
      "orders에 감독의 말을 원문 그대로 적는다 — 날짜·대상을 대신 채우지 않는다. 결과로 무엇이 걸렸고 무엇이 반려됐는지가 온다. " +
      "라인업·전술은 tactic_orders다.",
  },
  {
    name: "team_talk",
    label: "팀 토크",
    group: "대화·서사",
    readOnly: false,
    description:
      "감독이 선수단 전체에 한 발화의 결과를 기록한다. outcome은 맥락 적합성·설득 근거·선수단 수용성을 보고 판정하고, intensity는 발화 강도에 맞춘다(1 담담히 ~ 3 격하게). " +
      "결과는 전원의 상태를 움직이고, 아직 겉도는 새 영입에게 특히 크게 남는다. " +
      "들은 선수 중 할 말이 생긴 이의 심경은 moods에.",
  },
  {
    name: "talk_to_player",
    label: "선수 면담",
    group: "대화·서사",
    readOnly: false,
    description:
      "감독과 선수 개인의 면담 결과를 기록한다. 감독이 그 선수에게 건넨 말이 있을 때만 쓴다 — 이름을 부르기만 한 말은 부름이지 면담이 아니다. " +
      "outcome은 맥락 적합성·설득 근거·대상 수용성을 보고 판정한다. 불만은 사기가 오른 결과에만 풀린다. " +
      "새로 영입해 아직 적응 중인 선수는 면담으로 적응이 앞당겨진다(나쁜 결과면 늦춰진다) — 그 무게는 settling에 적는다. " +
      "면담 뒤 그 선수의 심경은 mood에.",
  },
  {
    name: "respond_to_media",
    label: "기자회견 대응",
    group: "대화·서사",
    readOnly: false,
    description:
      "감독이 기자회견에 답한 결과를 기록한다 — 스냅샷에 <press>가 없으면 쓰지 마라. " +
      "그 자리를 장면으로 열고, 질문은 사실 카드를 기자의 말로 옮겨 써라 — 그대로 읽지 않는다. 감독이 아직 답하지 않은 턴에는 묻기만 하고 이 도구를 부르지 않는다. " +
      "상대 감독 카드가 서면 기자가 그 말을 인용해 묻고, 감독이 그를 겨누면 targetManager에 이름을 적는다. " +
      "감독의 발화를 stance 하나로 옮긴다: defend(감싼다) · own(책임을 진다) · criticise(날을 세운다) · bold(도발) · deflect(말을 아낀다). " +
      "회견을 거절하거나 자리를 피했으면 decline: true. 이름이 불린 선수의 심경은 mood에.",
  },
  {
    name: "respond_to_approach",
    label: "찾아온 사람 응대",
    group: "대화·서사",
    readOnly: false,
    description:
      "먼저 열린 자리에 감독이 답한 결과를 기록한다(스냅샷의 <approach>에 화자와 사실이 실려 있다 — 없으면 쓰지 마라). " +
      "자리가 열려 있으면 지목된 화자로 장면을 열되 사실을 그대로 읽지 말고 그 사람의 말로 옮겨라. 감독이 아직 답하지 않은 턴에는 그 사람의 말까지만 쓰고 부르지 않는다. " +
      "감독의 발화를 stance 하나로 옮긴다 — respond_to_media와 같은 다섯이다. 자리를 주지 않고 돌려보냈으면 decline: true. 찾아온 선수의 심경은 mood에. " +
      "구단주가 건 조건을 두고 감독이 되물었으면 counter에 싣는다 — 기한을 늘려 달라면 extendDays, 조건을 낮춰 달라면 relax: true. 한 차례뿐이고 얼마나 물러서는지는 구단주가 정한다. " +
      "압력이 연 자리는 압력만 되돌린다 — 불만은 talk_to_player·승격·선발로만 풀린다. " +
      "감독직 면접 자리에서는 답이 제안 조건을 정한다 — own·defend는 기본 조건, bold는 연봉·이적 예산 약속을 흥정 천장까지 올리고 흥정 기회를 태우며, criticise·deflect·decline은 제안 없이 문을 닫는다.",
  },
  {
    name: "record_incident",
    label: "사건 기록",
    group: "대화·서사",
    readOnly: false,
    description:
      "벌금·포상·휴가·병문안·공개 칭찬과 질책·사과·중재·라커룸 규칙·회식처럼 다른 도구가 없는 행동을 감독이 했을 때 세운다. " +
      `kind는 효과의 모양이다: ${INCIDENT_KINDS.map((k) => `${k}(${INCIDENT_KIND_KO[k]})`).join(" · ")}. ` +
      "playerIds는 당사자의 이름, intensity는 세기 1~3, summary는 무슨 일이었나 한 줄. " +
      `사기와 관계만 움직이고 능력치·컨디션은 그대로다. 하루 ${MAX_INCIDENTS_PER_DAY}건까지. 당사자의 심경은 moods에.`,
  },
  {
    name: "apply_finance_event",
    label: "재정 이벤트",
    group: "재정",
    readOnly: false,
    description:
      "서사에서 벌어진 매출·비용을 장부에 남긴다 — 스폰서가 보너스를 얹거나(commercial), 유니폼이 동나거나(merchandising), 관중이 몰리거나(matchday), 시설이 망가지거나(facility), 원정 의료비가 들거나(travel_medical), 선수단에 포상을 주는(bonus) 일. " +
      "경기 운영비는 matchday_opex. 중계권·주급·이적료·상각·상금은 코어가 계산하므로 이 도구로 건드릴 수 없다. " +
      "£10k 미만의 식사·회식·택시 같은 일상 비용은 기록하거나 금액을 올려 잡지 않는다. 원장에 들어가 월간 보고서와 PSR에 그대로 반영된다.",
  },
  {
    name: "resign",
    label: "사임",
    group: "진행",
    readOnly: false,
    description:
      "감독이 계약을 물고 떠난다 — 잔여에 비례한 위약금이 지갑에서 나간다. " +
      "감독이 명확히 사임하겠다고 말했을 때만 부른다. 불만·이직 고민은 사임이 아니다. " +
      "부르면 무직이 되고 되돌릴 수 없다.",
  },
  {
    name: "search_players",
    label: "선수 검색",
    group: "조회",
    readOnly: true,
    description:
      '포지션·이름·나이·가용 상태에 계약 잔여·값·주급·리스트·홈그로운·잠재력·주발까지 걸어 찾는다. team="mine"은 우리 팀, 팀 id·이름은 특정 팀. ' +
      "team을 생략하면 풀이 5대 리그 1·2부 전체이므로, 우리 리그 안에서 비교할 때는 competition(epl 등)으로 좁힌다. " +
      'squadLevel="reserve"는 2군 유망주. 조건은 도구가 걸어라 — limit만큼 훑어 고르지 마라. ' +
      "sortBy는 age·fatigue·contract만 낮은 쪽이 앞이다. " +
      "우리 선수는 정확한 정보, 타 팀 선수는 지식 수준에 따른 평가와 값·계약 만료일을 준다. " +
      "playerId를 주면 능력치·컨디션·계약·배치에 부상 이력과 이번 시즌 경고 누적·이동 이력, 타 팀 선수라면 끝난 스카우트 보고서(도착 날짜·요구액·기대 주급)까지 붙은 상세 카드가 나온다 — 감독이 특정 선수를 두고 물으면 그 선수를 논하기 전에 먼저 호출한다.",
  },
  {
    name: "get_squad",
    label: "스쿼드·라인업 조회",
    group: "조회",
    readOnly: true,
    description:
      "우리 팀의 현재 배치를 본다 — 포메이션·팀 전술과 선발 11명·벤치·예비(배치 없음)를 자리 순서대로, " +
      "각자의 자리 적합도·포지션 적응도·전술 적응도·폼·체력과 부상·정지·경고 누적·불만 경고까지. " +
      'level="reserve"면 2군, role="starting"이면 선발만 본다. ' +
      "라인업·포지션·교체를 논하기 전에 호출한다. 타 팀 스쿼드는 볼 수 없다 — 상대 전력은 get_team으로.",
  },
  {
    name: "get_team",
    label: "팀 조회",
    group: "조회",
    readOnly: true,
    description:
      "팀의 순위·전적·전술·최근 경기·주요 선수를 조회한다. 다음 상대를 브리핑하거나 감독이 다른 팀을 물을 때 사용한다.",
  },
  {
    name: "get_league",
    label: "리그·일정 조회",
    group: "조회",
    readOnly: true,
    description:
      'view="standings" 순위표(competition으로 다른 리그·대항전도) — 행마다 최근 5경기 폼이 붙고, split="home"·"away"면 홈·원정 소계로 다시 세운 표다. 국내 컵은 대진표가 온다. ' +
      'view="leaders" 그 리그의 개인 순위(득점·도움·평점·클린시트·징계 상위 10 · key로 한 축만)와 팀 열(득점·실점·무실점·슛·xG). 대항전은 개인 순위가 없다. ' +
      'view="fixtures" 일정 검색 — team(기준 팀, 생략하면 우리 팀, "all"이면 대회 전체), opponent(맞대결만 · 전적 요약), competition, when(past·upcoming·both), from·to, round, count. ' +
      "season을 주면 지나간 시즌 — 순위표는 그때의 최종 표, 일정은 결산에 남은 감독 팀의 경기뿐이다. " +
      'view="calendar" 감독의 달력 — 경기·훈련·이적창을 날짜순으로. 기본 오늘부터 14일이고 from·to·days로 범위를, type="training"으로 훈련만 본다. 새 훈련을 잡기 전에 이걸로 확인하라. from이 지난 날이면 그 사이 벌어진 일이 일지로 함께 온다.',
  },
  {
    name: "get_match_report",
    label: "경기 리포트",
    group: "조회",
    readOnly: true,
    description:
      "끝난 경기 하나를 통째로 읽는다 — 타임라인(골의 원인 태그 포함)·팀 스탯(점유·슛·xG·기대 득점·패스·코너·파울·카드)·선수별 기록·평점과 그 한 줄 근거·MOTM. " +
      "감독이 지난 경기의 내용·패인·누가 잘했는지를 물으면 스코어만 들고 답하지 말고 이걸 부른다. " +
      "경기는 opponent(상대 팀 이름·약칭)·competition(epl·ucl·facup 등)·date(YYYY-MM-DD)로 고르고, 아무것도 주지 않으면 가장 최근에 끝난 우리 경기다. matchId를 알면 그것만 준다.",
  },
  {
    name: "get_opponent_report",
    label: "상대 분석",
    group: "조회",
    readOnly: true,
    description:
      "다음 경기 상대를 경기 전에 읽는다 — 예상 XI(상대의 직전 경기 선발에서 투영)·결장자(부상·정지)·상대 모양과 전술 6축·감독이 읽어 낸 지점(전술 상성과 미스매치). " +
      '감독이 경기 전에 상대를 묻거나("쟤네 어떻게 나와") 누굴 노릴지·누굴 세울지 상의하면 순위와 최근 5경기만 들고 답하지 말고 이걸 부른다. ' +
      "지점 줄의 +는 우리에게 이로운 것, -는 상대에게 이로운 것이다. 몇 개가 보이는지는 감독의 분석 능력이, 이름과 수치가 보이는지는 전술 능력이 정한다 — 흐린 줄을 또렷한 척 옮기지 않는다. " +
      "경기는 opponent(상대 팀 이름·약칭)·competition(epl·ucl·facup 등)·date(YYYY-MM-DD)로 고르고, 아무것도 주지 않으면 다음 우리 경기다. " +
      "⚠️ 예상 XI는 예상이다 — 상대가 로테이션을 돌리면 갈리므로 확정으로 말하지 않는다. 경기 중에는 부를 수 없다(판세 화면이 지금 판을 들고 있다).",
  },
  {
    name: "get_career",
    label: "커리어 조회",
    group: "조회",
    readOnly: true,
    description:
      "감독의 커리어 — 이번 시즌 진행 상황, 지난 시즌들의 순위·전적·보드 평가, 트로피, 업적, 맡은 팀이 받은 시상. " +
      "지나간 시즌의 순위표·우승자·감독 팀의 경기는 get_history가 낸다.",
  },
  {
    name: "get_history",
    label: "역대 기록 조회",
    group: "조회",
    readOnly: true,
    description:
      "지나간 시즌의 장부를 읽는다. season으로 그 시즌의 우승자와 우리 성적을, season+competition으로 그 시즌 그 대회의 최종 순위표(녹아웃은 우승·준우승)를 본다. " +
      "team이면 그 구단의 역대 — 우승 횟수·한 시즌 최다 승점·최다 득점·최고 순위·그 구단 소속의 시상. player면 그 선수의 통산과 받은 상(은퇴한 선수도 찾는다). " +
      "competition만 주면 그 대회의 역대 우승이 시즌마다 한 줄로 온다. 아무것도 주지 않으면 지나간 시즌 목록이 최근부터 온다. " +
      "지난 시즌을 두고 순위·우승·구단 역사·역대 최다를 물으면 지어내지 말고 이걸 부른다. " +
      "장부에 남은 지난 시즌 경기는 감독 팀의 것뿐이다 — 남의 팀끼리의 지난 시즌 스코어는 없고, 없는 것은 없다고 답한다.",
  },
  {
    name: "get_finance",
    label: "재정 조회",
    group: "조회",
    readOnly: true,
    description:
      '구단 재정을 조회한다 — 잔고·이적 예산·주급 총액·주급 여력·미지급 분할 회분·부채·1년 안에 끝나는 계약 전원, 월간 보고서(수입·지출, 현금 순증과 장부 손익, 급여 비중, PSR 여유), 이번 달 잠정 집계. month를 주면 그 달 보고서만 본다("2026-08"). 영입은 오퍼 전에 이것부터 읽어라 — 주급 여력이 음수면 못 산다.',
  },
  {
    name: "scout_player",
    label: "스카우트 파견",
    group: "조회",
    readOnly: false,
    description:
      "타 팀 선수에게 스카우트를 파견한다. 며칠 뒤 보고서가 오면 실행 계열은 거의 정확해지고 판단 계열에는 오차가 남는다 — 같은 선수에게 거듭 보낼수록 잠재력 구간이 좁아진다. 도착한 보고서는 그 선수의 상세 카드에 남는다 — 지난 보고서를 물으면 다시 파견하지 않는다.",
  },
  {
    name: "scout_mission",
    label: "스카우트 임무",
    group: "조회",
    readOnly: false,
    description:
      "이름 대신 조건으로 스카우트를 내보낸다 — 대회(competition)·자리(position)·나이 상하한(minAge·maxAge)·관측 시장가 상한(maxValue) 중 감독이 말한 것만 싣는다. 대회를 비우면 5대 리그 1·2부 전체가 풀이다. " +
      `${MISSION_DAYS}일 뒤 후보 ${MISSION_CANDIDATES}명이 카드로 온다. ` +
      "조건으로 찾아오라는 지시는 search_players가 아니라 이것이다. " +
      "돌아온 후보는 직접 상대해 본 선수만큼만 보이고, 관측값은 각자의 상세 카드에 남는다 — 더 알아야 하면 그 이름으로 scout_player를 보낸다. " +
      "동시 파견 한도는 scout_player와 나눠 쓴다 — 어느 쪽이든 자리가 없으면 대기로 남고, 자리가 난 뒤 다시 불러야 나간다.",
  },
  {
    name: "deal_odds",
    label: "딜 성공 확률",
    group: "이적",
    readOnly: true,
    description:
      "이 조건이면 이적이 성사될지 코어가 계산한 확률과 그 근거(요구액·주급 기대치·기여 항목)를 준다. 감독에게 답하기 전에 확인하고, 그 근거는 사람의 말로 풀어 전하라. 확률이 낮다고 포기하지 마라.",
  },
  {
    name: "list_negotiations",
    label: "협상 목록",
    group: "이적",
    readOnly: true,
    description:
      "진행 중인 협상을 요약한다. negotiationId를 주면 오퍼 이력과 현재 확률 근거까지 자세히 본다.",
  },
  {
    name: "market_orders",
    label: "이적·재정 지시",
    group: "이적",
    readOnly: false,
    description:
      "감독이 시장과 장부를 움직이는 지시를 했을 때 — 오퍼·상대 오퍼에 답·계약 확정·철회·재계약·해지·이적 리스트·이적 요청 답·되사기·임대 복귀·이적 예산·보드 요청·사재 출연·보너스·표값·스태프 고용·계약 해지·감독직 수락·흥정·지원. " +
      "orders에 감독의 말을 원문 그대로 적는다 — 액수·상대를 대신 채우지 않는다. 오퍼 전에는 deal_odds로 확률을 보고 감독과 값을 정한 뒤 넘긴다. 결과로 무엇이 걸렸고 무엇이 반려됐는지가 온다. " +
      "우리 오퍼에 온 상대의 답은 여기가 아니다 — <letters>가 나른다. 마주 앉아 하는 말은 speak_at_table이다.",
  },
  {
    name: "speak_at_table",
    label: "테이블",
    group: "이적",
    readOnly: false,
    description:
      "협상 상대와 마주 앉아 감독의 말을 건넨다 — line은 감독의 말 원문이다. 상대의 답이 <reply speaker name>으로 돌아오고, 그 답은 그 사람의 말로 장면에 옮기되 지어내지 않는다. 영입의 테이블에는 값을 답하는 구단과 개인 조건을 답하는 선수 쪽이 함께 앉아 답이 둘일 수 있다 — 누구에게 건네는 말인지는 line의 내용이 정한다. " +
      "테이블에 오퍼가 올라 있으면(send_offer·respond_offer를 먼저) 상대는 그 자리에서 답한다 — 편지처럼 며칠을 기다리지 않는다. 조건 없는 말도 건넬 수 있다. " +
      "감독이 든 논거는 상대가 듣고 코어가 사실을 가린다 — 당신이 pitch로 옮기지 않는다. 인내가 0이 되면 상대가 일어나고 협상은 이번 창에서 끝난다. 협상이 없으면 먼저 오퍼나 재계약을 열어라.",
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
