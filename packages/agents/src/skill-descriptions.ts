import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dataDir } from "@story-fm/engine";

export type SkillGroup = "진행" | "전술·훈련" | "대화·서사" | "조회" | "경기" | "이적" | "재정";

export interface SkillCatalogEntry {
  name: string;
  label: string;
  group: SkillGroup;
  readOnly: boolean;
  description: string;
}

/** 모델에 제공하는 도구 설명의 코드 기본값과 어드민 표시 메타데이터. */
export const SKILL_CATALOG = [
  {
    name: "start_match",
    label: "경기 시작",
    group: "진행",
    readOnly: false,
    description:
      "경기일에 킥오프를 준비한다. 이후 경기 마스터가 경기를 진행한다. " +
      "감독이 들어가자고 할 때 부른다.",
  },
  {
    name: "set_lineup",
    label: "라인업",
    group: "전술·훈련",
    readOnly: false,
    description:
      "선발 11명과 벤치를 정한다. 좌표(point)나 포지션 코드로 자리를 지정할 수 있고, 지정하지 않은 선수의 자리는 건드리지 않는다. squadLevels로 1·2군 이동을 같은 요청에 실어라 — 2군 선수를 선발에 넣으려면 그 배열에 first로 함께 적는다.",
  },
  {
    name: "set_captain",
    label: "주장 지정",
    group: "전술·훈련",
    readOnly: false,
    description:
      "우리 팀 선수 한 명을 주장으로 지명한다. 지명된 선수는 상태가 오르고, 새 영입이면 적응이 앞당겨진다. " +
      "리더십이 높은 고참을 세우는 것이 보통이지만 누구를 세울지는 감독의 판단이다 — 어린 핵심에게 완장을 주는 것도 서사가 된다. " +
      "2군으로 내리면 주장 자리는 자동으로 비워진다.",
  },
  {
    name: "set_tactics",
    label: "팀 전술 변경",
    group: "전술·훈련",
    readOnly: false,
    description:
      "포메이션과 전술 6축을 변경한다. 축은 모두 1~5이며 3이 보통이다 — " +
      "멘탈리티(1 수비적~5 공격적) · 수비 라인(1 낮게~5 높게) · 압박(1 최소~5 맹렬히) · " +
      "템포(1 느리게~5 빠르게) · 폭(1 좁게~5 넓게) · 패스(1 짧게~5 길게). " +
      "감독이 언급한 항목만 보내며, 경기 중 변경은 다음 진행부터 반영된다.",
  },
  {
    name: "set_player_tactic",
    label: "선수 전술",
    group: "전술·훈련",
    readOnly: false,
    description:
      "한 선수의 자리·역할·개인 지시를 한 번에 정한다. position은 이미 그라운드에 있는 선수의 자리를 옮기고(교체가 아니다 — 벤치 선수를 넣으려면 substitute), role은 그 자리의 세부 역할(레지스타·인버티드 윙백 등), instruction은 개인 지시다. 경기 중에도 쓸 수 있다.",
  },
  {
    name: "exploit_point",
    label: "약점 공략",
    group: "전술·훈련",
    readOnly: false,
    description:
      "감독이 읽어낸 약점을 겨냥한다. 상태의 [공략 가능한 지점] 목록에 있는 id만 쓸 수 있고 동시에 두 곳까지다 — 그 이상은 코어가 자른다. 한쪽을 파고들면 다른 쪽이 열린다(이득에만 소화율이 곱해지고 대가는 온전히 치른다). 경기 중에만 뜻이 있다.",
  },
  {
    name: "set_training",
    label: "훈련 지정",
    group: "전술·훈련",
    readOnly: false,
    description:
      "**훈련의 단일 입구** — 팀 일정 등록·비우기·개인 훈련이 모두 여기로 온다. 감독이 말한 훈련만 등록한다. 팀에는 이미 경기 일정에 맞춘 기본 훈련(회복·전술·본훈련)이 깔려 있으므로, 이 도구는 그 위에 감독의 지시를 얹는 것이다 — 같은 날 같은 슬롯은 덮어쓴다. 특정 날짜 sessions 또는 요일 반복 repeatWeekly에 오전(am)·오후(pm), 자연어 label, 효과 대상 focus를 지정한다. focus는 능력치 축 또는 tactical·recovery를 사용한다. 임의로 빈 세션을 채우지 말고 감독의 표현을 구체적인 훈련과 관련 focus로 해석한다. 훈련을 **없애는** 지시(쉬게 하자·취소해줘)는 clear로 보낸다 — rest=true(기본)면 그 자리를 쉬는 날로 못 박아 기본 훈련이 다시 들어오지 않고, rest=false면 감독이 잡은 특별 훈련만 걷어 평소 일정으로 돌린다. from·to·dow·slot으로 범위를 좁힌다. 한 선수만 겨냥한 개인 훈련은 player로 보낸다(axis 또는 position, clear=true면 거둔다). 시즌 초 여름 휴가 중에는 훈련을 잡을 수 없다 — 감독이 **휴가를 접고 부르겠다**고 하면 recallSquad를 함께 보내라. 그러면 소집일이 그날로 앞당겨지고 선수단은 체력을 잃고 일부는 불만을 품는다(면담·팀토크로 풀 수 있다). 감독이 그렇게 말하지 않았으면 보내지 마라.",
  },
  {
    name: "team_talk",
    label: "팀 토크",
    group: "대화·서사",
    readOnly: false,
    description:
      "감독이 선수단 전체에 한 발화의 결과를 기록한다. outcome은 맥락 적합성·설득 근거·선수단 수용성을 보고 판정하고, intensity는 발화 강도에 맞춘다(1 담담히 ~ 3 격하게). " +
      "occasion은 언제 한 말인지다 — pre(경기 전 라커룸) · half(하프타임) · post(경기 후) · daily(훈련장·평소). " +
      "결과는 전원의 상태를 움직이고, 아직 겉도는 새 영입에게 특히 크게 남는다.",
  },
  {
    name: "talk_to_player",
    label: "선수 면담",
    group: "대화·서사",
    readOnly: false,
    description:
      "감독과 선수 개인의 면담 결과를 기록한다. outcome은 발화의 질과 대상의 수용성을 보고 판정하며, 해당 선수의 불만 이슈가 있으면 결과에 따라 해소될 수 있다. " +
      "새로 영입해 아직 적응 중인 선수는 면담으로 적응이 앞당겨진다(나쁜 결과면 늦춰진다) — 그 무게는 settling에 적는다.",
  },
  {
    name: "respond_to_media",
    label: "기자회견 대응",
    group: "대화·서사",
    readOnly: false,
    description:
      "감독이 **열려 있는 기자회견**에 답한 결과를 기록한다(스냅샷의 '기자회견 대기'에 기자가 아는 사실이 실려 있다 — 없으면 쓰지 마라). " +
      "감독의 발화를 stance 하나로 옮긴다: defend(선수·팀을 감싼다) · own(책임을 진다) · criticise(공개적으로 날을 세운다) · bold(도발·자신감) · deflect(말을 아낀다). " +
      "감독이 특정 선수를 두고 말했다면 targetPlayerId에 그 선수를 적는다(사실 카드에 선수가 걸려 있으면 기본값이 그 선수다). " +
      "감독이 **회견을 거절하거나 자리를 피했다면** decline=true로 보낸다 — 그것도 하나의 답이고 언론 평판을 잃는다. " +
      "효과(평판 3축·선수 사기)는 코어가 정하므로 수치를 지어내지 마라.",
  },
  {
    name: "substitute",
    label: "선수 교체",
    group: "경기",
    readOnly: false,
    description:
      "경기 정지점에서 우리 팀 선수를 교체한다. out에는 나가는 선수 id, in에는 들어오는 벤치 선수 id를 넣는다.",
  },
  {
    name: "advance_match",
    label: "경기 진행",
    group: "경기",
    readOnly: false,
    description:
      "다음 정지점까지 경기를 진행하고 그 구간에 실제로 일어난 일을 돌려준다. " +
      "감독의 지시(교체·전술·개인 지시)를 먼저 도구로 처리한 뒤 부른다 — 그래야 그 지시가 이 구간에 반영된다. " +
      "돌려받은 사건이 이번 턴에 중계할 전부이고, 한 턴에 한 번만 부른다. " +
      "감독이 묻기만 했으면 부르지 않는다.",
  },
  {
    name: "apply_narrative_event",
    label: "서사 상태 반영",
    group: "대화·서사",
    readOnly: false,
    description:
      "서사에서 실제로 일어난 사건의 체력·폼 변화를 허용 범위 안에서 기록한다. 능력치나 다른 장부 값은 바꿀 수 없다.",
  },
  {
    name: "apply_finance_event",
    label: "재정 이벤트",
    group: "재정",
    readOnly: false,
    description:
      "서사에서 벌어진 매출·비용을 장부에 남긴다 — 스폰서가 보너스를 얹거나(commercial), 유니폼이 동나거나(merchandising), 관중이 몰리거나(matchday), 시설이 망가지거나(facility), 원정 의료비가 들거나(travel_medical), 선수단에 포상을 주는(bonus) 일. " +
      "경기 운영비는 matchday_opex. 중계권·주급·이적료·상각·상금은 코어가 계산하므로 이 도구로 건드릴 수 없다. " +
      "금액은 주급 총액에 매인 하루 한도가 있고, 원장에 들어가 월간 보고서와 PSR에 그대로 반영된다.",
  },
  {
    name: "adjust_transfer_budget",
    label: "이적 예산 조정",
    group: "재정",
    readOnly: false,
    description:
      "구단주·보드가 이적 예산을 늘리거나 줄인다(delta는 음수도 가능). 자본 이동이라 손익·PSR에는 잡히지 않고, PSR로 동결된 예산은 이 도구로 풀 수 없다 — 매각이 먼저다. " +
      "매출이 늘어난 일은 이 도구가 아니라 apply_finance_event로 기록한다. " +
      "선수를 판 돈은 accept_deal이 원장을 거쳐 넣으므로 이 도구로 이적료를 대신 반영하지 마라 — 한도는 하루 누적이다.",
  },
  {
    name: "search_players",
    label: "선수 검색",
    group: "조회",
    readOnly: true,
    description:
      '포지션·이름·나이·가용 상태 등으로 선수를 찾는다. team="mine"은 우리 팀, 팀 id·이름은 특정 팀. ' +
      "team을 생략하면 풀이 **5대 리그 1·2부 전체**이므로, 우리 리그 안에서 비교할 때는 competition(epl 등)으로 반드시 좁혀라 — " +
      '"리그 득점왕", "리그 최고 스트라이커" 같은 질문에 다른 리그 선수가 섞여 나온다. ' +
      'squadLevel="reserve"로 2군 유망주만 볼 수 있고, sortBy는 rating·age·fatigue·goals·apps·wage. ' +
      "우리 선수는 정확한 정보, 타 팀 선수는 지식 수준에 따른 평가를 반환한다. " +
      "**playerId를 주면 그 선수 한 명의 상세 카드**를 돌려준다 — 능력치·컨디션·계약·배치에 더해 부상 이력(횟수·누적 결장일·부위), 이번 시즌 경고 누적과 정지까지 남은 장수, 이동 이력까지. " +
      '"부상이 잦은가", "다음 경기 경고 조심해야 하나" 같은 판단은 그 이력으로 하라. 감독이 특정 선수를 언급했고 컨텍스트만으로 답할 수 없으면 먼저 호출한다.',
  },
  {
    name: "get_squad",
    label: "스쿼드·라인업 조회",
    group: "조회",
    readOnly: true,
    description:
      "우리 팀의 **현재 배치**를 본다 — 포메이션·팀 전술과 선발 11명·벤치·예비(배치 없음)를 자리 순서대로, " +
      "각자의 자리 적합도·포지션 적응도·전술 적응도·폼·체력과 부상·정지·경고 누적·불만 경고까지. " +
      'level="reserve"면 2군, role="starting"이면 선발만 본다. ' +
      "라인업·포지션·교체를 논하기 전에 반드시 호출하라 — 지금 누가 어디에 서 있는지는 선수 명부에 없다. " +
      "타 팀 스쿼드는 볼 수 없다(상대 라인업을 미리 아는 것은 규칙 위반) — 상대 전력은 get_team으로.",
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
      'view="standings"는 순위표(competition으로 다른 리그·대항전도 가능), view="fixtures"는 일정 검색이다. ' +
      '국내 컵(facup·eflcup·copadelrey·coppaitalia·dfbpokal·coupedefrance)은 순위표가 없는 녹아웃이라 view="standings"가 **대진표**를 돌려준다 — "FA컵", "리그컵", "포칼"처럼 불러도 해석된다. ' +
      '일정은 조건으로 찾는다 — team(기준 팀, 생략하면 우리 팀, "all"이면 대회 전체), opponent(상대 팀 — 주면 그 팀과의 맞대결만 보고 전적 요약이 붙는다), competition(epl·ucl·facup 등), when(past 지난 경기만·upcoming 예정만·both), from·to(YYYY-MM-DD 범위), round, count. ' +
      '예) "다음 맨유전"은 opponent="맨유", when="upcoming", count=1 / "토트넘과 지난 맞대결"은 opponent="토트넘", when="past" / "이번 주 리그 경기"는 team="all"에 from·to. ' +
      "팀 이름은 약칭도 해석되고(맨유·스퍼스·레알), 못 찾으면 후보를 돌려준다. 순위표에는 최근 5경기 폼이 함께 나온다. " +
      "순위·승점·날짜·스코어는 추측하지 말고 반드시 이 도구로 확인한다. " +
      'view="calendar"는 **감독의 달력** — 경기·훈련·이적창 개폐를 한 축에서 날짜순으로 본다. 기본은 오늘부터 14일이고 from·to·days로 범위를, type="training"으로 훈련만 볼 수 있다. 훈련 계획을 묻거나 새 훈련을 잡기 전에 이걸로 확인하라 — 상태 스냅샷에는 다음 몇 건만 보인다.',
  },
  {
    name: "get_career",
    label: "커리어 조회",
    group: "조회",
    readOnly: true,
    description:
      "감독의 커리어 — 이번 시즌 진행 상황, **지난 시즌들의 순위·전적·보드 평가**, 트로피, 업적. " +
      "경기 장부는 시즌이 넘어가면 새 시즌으로 교체되므로 과거를 말할 때는 반드시 이 도구로 확인하라 (지난 시즌 개별 경기 결과는 남지 않는다 — 시즌 단위 요약만 있다).",
  },
  {
    name: "get_finance",
    label: "재정 조회",
    group: "조회",
    readOnly: true,
    description:
      '구단 재정을 조회한다 — 잔고·이적 예산·주급 총액, 월간 재정 보고서(수입·지출 항목, 현금 순증과 장부 손익, 급여 비중, PSR 여유), 진행 중인 이번 달 잠정 집계. month를 주면 그 달 보고서만 본다("2026-08"). 금액·수지는 추측하지 말고 이 도구로 확인한다.',
  },
  {
    name: "scout_player",
    label: "스카우트 파견",
    group: "조회",
    readOnly: false,
    description:
      "타 팀 선수에게 스카우트를 파견한다. 며칠 뒤 보고서가 완료되면 능력치를 정확히 파악하지만 잠재력은 공개되지 않는다. 진지한 영입 검토나 상대 핵심 분석에 사용하며 동시 파견 한도가 있다.",
  },
  {
    name: "deal_odds",
    label: "딜 성공 확률",
    group: "이적",
    readOnly: true,
    description:
      "이 조건이면 이적이 성사될지 코어가 계산한 확률과 그 근거(요구액·주급 기대치·기여 항목)를 준다. 상태를 바꾸지 않으므로 감독에게 답하기 전에 반드시 확인하라. kind를 sell로 주면 매각 방향(사는 쪽이 그 값을 낼지·선수가 떠날지)으로 계산한다. pitch를 함께 주면 **설득 논거를 미리 시험**할 수 있다 — 어떤 이야기가 사실로 통하고 어떤 게 거짓으로 드러나는지 근거에 한 줄씩 나온다. 확률이 낮다고 포기하지 마라: 돈으로 안 되는 딜을 논거로 넘는 것이 이 게임의 이적이다.",
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
    name: "send_offer",
    label: "오퍼",
    group: "이적",
    readOnly: false,
    description:
      "이적 오퍼를 넣는다. kind=buy(기본)는 타 팀 선수 영입, kind=sell은 우리 선수를 파는 제안, kind=loan은 임대 영입(fee는 임대료, weeklyWage는 우리가 부담할 주급), kind=loan_out은 우리 선수를 임대로 내보내는 제안이다(fee는 받을 임대료, weeklyWage는 그쪽이 낼 주급). sell·loan_out은 teamId가 필요하다. 넣기 전에 deal_odds로 확률을 확인하라. 답은 며칠 뒤에 오고 같은 조건을 반복하면 상대가 지친다. **pitch**: 감독이 말로 든 설득 논거를 kind로 옮긴다(대항전·주전 보장·팀의 중심·고향 복귀·과거 인연·동포·우승 도전·감독 이름·마지막 기회). 코어가 상태와 대조해 사실인 것만 확률을 올리고 거짓은 깎으므로 감독이 하지 않은 말을 지어내면 손해다. 목록에 없는 이야기는 kind=other로 넣으면 서사에만 남는다.",
  },
  {
    name: "respond_offer",
    label: "오퍼 판정",
    group: "이적",
    readOnly: false,
    description:
      "오퍼에 답한다 (accept·counter·reject) — **누가 답할 차례인지는 협상이 안다.** 우리가 넣은 오퍼면 당신이 상대 구단·선수·에이전트가 되어 판정하고, 상대가 넣은 오퍼면 감독의 뜻대로 답한다. 답이 도착한 협상은 서사만 쓰지 말고 반드시 이 도구로 기록해야 다음 단계로 간다. deal_odds의 확률과 근거를 앵커로 삼고 note에 한 줄을 남긴다. **설득 논거가 붙은 협상은 확률만 보고 거절하지 마라** — 그 이야기가 이 선수에게 얼마나 큰지는 당신이 판정한다. counter는 방향이 갈린다: 영입이면 더 부르고(우리 제시액 이상·요구액 +15% 이하), 매각이면 사는 쪽이 깎아 부르고(시장가 55% 이상·우리 호가 미만), 재계약이면 선수가 주급을 부른다(우리 제시액 초과·기대치 1.4배 이하).",
  },
  {
    name: "accept_deal",
    label: "계약 확정",
    group: "이적",
    readOnly: false,
    description:
      "합의된 협상을 다음 단계로 넘긴다. **첫 호출은 계약이 아니라 메디컬이다** — 검진 날짜가 잡히고, 통과하면 그날 코어가 이적료·계약·재정·소속을 함께 반영한다. 그러니 이 도구를 부른 턴에 도장·발표·기자회견을 쓰지 마라. 검진 결과를 기다리는 동안 다시 부를 필요는 없다. 소견이 나온 뒤 다시 부르면 그것은 **소견을 알고도 데려오겠다는 강행**이고, 물러설 때는 withdraw_offer다.",
  },
  {
    name: "set_transfer_list",
    label: "이적 리스트",
    group: "이적",
    readOnly: false,
    description:
      "우리 선수를 이적 리스트에 올리거나 뺀다 — 감독이 '이 선수는 팔겠다'고 할 때 여기로 온다. askingPrice(호가)를 생략하면 코어의 요구가를 쓴다. 등재하면 그 선수를 노리는 오퍼가 들어오기 시작하고, 비싸게 부를수록 더디 붙는다. 오퍼가 오면 respond_offer로 답하고 accept_deal로 확정해야 실제 이적이다.",
  },
  {
    name: "withdraw_offer",
    label: "협상 철회",
    group: "이적",
    readOnly: false,
    description: "진행 중인 협상에서 물러난다. 그 창에서 같은 선수에게 다시 오퍼할 수 없다.",
  },
  {
    name: "release_player",
    label: "계약 해지",
    group: "이적",
    readOnly: false,
    description:
      "우리 선수와의 계약을 해지한다 (방출). 잔여 계약 주급의 절반을 위약금으로 **즉시** 물고 원장에 남으므로 PSR에도 잡힌다 — 안 팔리는 고액 계약을 정리하는 마지막 수단이다. 감독의 확인을 받고 호출하라. 팔 수 있는 선수라면 매각이 언제나 낫다.",
  },
  {
    name: "recall_loan",
    label: "임대 복귀",
    group: "이적",
    readOnly: false,
    description:
      "임대 보낸 우리 선수를 기한 전에 불러들인다. 돌아온 선수는 2군으로 들어온다. **내보내는 임대는 send_offer(kind=loan_out)**, 데려오는 임대는 send_offer(kind=loan)다.",
  },
  {
    name: "open_renewal",
    label: "재계약 제안",
    group: "이적",
    readOnly: false,
    description:
      "우리 선수에게 재계약을 제안한다 (주급·연수). 이적창과 무관하게 언제든 가능하고, 상대는 구단이 아니라 선수 본인이다. 제안 전에 deal_odds(kind=renew)로 확률을 확인하라. 선수가 주급을 더 요구하면 그 값으로 다시 제안하면 된다.",
  },
] as const satisfies readonly SkillCatalogEntry[];

export type SkillName = (typeof SKILL_CATALOG)[number]["name"];
export type SkillDescriptions = Record<SkillName, string>;

export const SKILL_NAMES = SKILL_CATALOG.map((skill) => skill.name);

export const DEFAULT_SKILL_DESCRIPTIONS = Object.fromEntries(
  SKILL_CATALOG.map((skill) => [skill.name, skill.description]),
) as SkillDescriptions;

export interface ResolvedSkillDescriptions {
  descriptions: SkillDescriptions;
  edited: boolean;
}

const StoredSkillDescriptionsSchema = z.object({
  version: z.literal(1),
  descriptions: z.record(z.string().min(1)),
});

/** 스킬 설명 오버라이드 파일 — 시스템 프롬프트와 별도로 관리한다. */
export function skillDescriptionsPath(): string {
  return path.join(dataDir(), "skill-descriptions.json");
}

/** 저장된 설명 중 현재 코드에 존재하는 스킬만 읽는다. */
export function loadSkillDescriptionOverrides(): Partial<SkillDescriptions> | null {
  const file = skillDescriptionsPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = StoredSkillDescriptionsSchema.safeParse(
      JSON.parse(readFileSync(file, "utf8")) as unknown,
    );
    if (!parsed.success) return null;
    const overrides: Partial<SkillDescriptions> = {};
    for (const name of SKILL_NAMES) {
      const description = parsed.data.descriptions[name];
      if (description !== undefined) overrides[name] = description;
    }
    return overrides;
  } catch {
    return null;
  }
}

/** 코드 기본값과 저장된 편집본을 합쳐 이번 LLM 턴에 사용할 설명을 만든다. */
export function resolveSkillDescriptions(
  defaults: SkillDescriptions = DEFAULT_SKILL_DESCRIPTIONS,
): ResolvedSkillDescriptions {
  const overrides = loadSkillDescriptionOverrides();
  if (!overrides) return { descriptions: defaults, edited: false };
  const descriptions = { ...defaults, ...overrides };
  return {
    descriptions,
    edited: SKILL_NAMES.some((name) => descriptions[name] !== defaults[name]),
  };
}

/** 모든 현재 스킬 설명을 원자적으로 저장한다. */
export function saveSkillDescriptionOverrides(descriptions: SkillDescriptions): void {
  for (const name of SKILL_NAMES) {
    if (descriptions[name].trim().length === 0) {
      throw new Error(`빈 스킬 설명: ${name}`);
    }
  }
  const parsed = StoredSkillDescriptionsSchema.parse({ version: 1, descriptions });
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const file = skillDescriptionsPath();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2), "utf8");
  renameSync(tmp, file);
}

/** 저장된 스킬 설명 편집본을 삭제하고 코드 기본값으로 되돌린다. */
export function resetSkillDescriptionOverrides(): void {
  const file = skillDescriptionsPath();
  if (existsSync(file)) rmSync(file);
}
