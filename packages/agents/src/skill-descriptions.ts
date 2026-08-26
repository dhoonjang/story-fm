import {
  MISSION_CANDIDATES,
  MISSION_DAYS,
  TACTIC_AXES,
  TACTIC_TOGGLES,
  tacticAxisScaleText,
  tacticToggleChoiceText,
} from "@story-fm/domain";

export type SkillGroup = "진행" | "전술·훈련" | "대화·서사" | "조회" | "경기" | "이적" | "재정";

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
 * 판정 근거는 `MATCH_INTENT_SYSTEM`이 따로 갖는다 — 그 겹침은 중복이 아니다.
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
    name: "set_lineup",
    label: "라인업",
    group: "전술·훈련",
    readOnly: false,
    description:
      "선발 11명과 벤치를 정한다. 자리는 포지션 코드로 지정하고, 지정하지 않은 선수의 자리는 건드리지 않는다. squadLevels로 1·2군 이동을 같은 요청에 실어라 — 2군 선수를 선발에 넣으려면 그 배열에 first로 함께 적는다.",
  },
  {
    name: "set_squad_level",
    label: "1·2군 이동",
    group: "전술·훈련",
    readOnly: false,
    description:
      "선수를 1군으로 올리거나 2군으로 내린다 — 배치는 건드리지 않는다. 감독이 층만 말했으면 라인업을 다시 짜지 말고 이 도구를 쓴다. " +
      "여럿이면 moves에 모아 한 번에 보낸다 — 하나라도 규칙(등록 명단·1군 하한 20명)에 걸리면 아무도 옮기지 않는다. " +
      "내려간 선수는 전술 배치에서 함께 빠진다. 2군 선수를 곧바로 선발에 넣는 지시라면 set_lineup에 squadLevels로 함께 실어라.",
  },
  {
    name: "set_development_focus",
    label: "집중 육성",
    group: "전술·훈련",
    readOnly: false,
    description:
      "2군 유망주를 집중 육성으로 지정한다(최대 3명) — 성장이 빨라지고, 2군 리그 출전과 겹치면 더 빠르다. " +
      "지정 전체를 다시 적는 목록 교체다 — playerIds를 생략하면 해제. 2군만 지정할 수 있고, 승격하면 풀린다.",
  },
  {
    name: "sign_youth",
    label: "유스 첫 계약",
    group: "전술·훈련",
    readOnly: false,
    description:
      "여름의 유스 후보 중 첫 프로 계약을 줄 선수를 고른다 — **한 번의 확정이다**. 고른 이름이 계약하고 나머지 후보는 사라진다. " +
      "playerIds를 생략하면 전원 돌려보낸다. 선수단 소집일이 기한이고, 감독이 답하지 않으면 구단이 앞에서부터 정해진 수만큼 채운다. " +
      "고른 뒤에도 포지션군 최소 인원이 무너지면 구단이 남은 후보에서 그 자리를 채운다.",
  },
  {
    name: "set_mentor",
    label: "멘토링",
    group: "전술·훈련",
    readOnly: false,
    description:
      "고참에게 유망주를 맡긴다(한 멘토당 최대 3명) — 멘티의 정신 6축 성장과 새 영입의 적응이 빨라진다. " +
      "멘토는 우리 1군 30세 이상·리더십 55 이상, 멘티는 23세 이하 우리 선수이며 한 선수는 한 멘토에게만 간다. " +
      "그 멘토의 멘티 전체를 다시 적는 목록 교체다 — menteeIds를 생략하면 그 멘토의 사이를 다 푼다. " +
      "멘토가 2군으로 내려가거나 어느 한쪽이 팀을 떠나면 풀린다.",
  },
  {
    name: "set_reserve_training",
    label: "2군 훈련 방침",
    group: "전술·훈련",
    readOnly: false,
    description:
      "우리 2군이 어느 축을 겨냥해 자랄지 정한다 — physical(신체 4축) · technical(기술 5축) · mental(정신 6축) · balanced(해제). " +
      "총량은 늘지 않는다 — 겨냥한 축이 빨라지는 만큼 나머지 필드 축이 느려진다. 골키핑은 어느 방침에도 닿지 않는다. " +
      "팀 하나에 방침 하나이고, 1군과 타 팀에는 닿지 않는다.",
  },
  {
    name: "set_captain",
    label: "완장 지정",
    group: "전술·훈련",
    readOnly: false,
    description:
      "우리 팀의 완장을 채운다 — 주장(playerId)과 부주장(vice)을 한 번에 옮길 수 있고, 말한 자리만 바뀐다. " +
      "주장으로 지명된 선수는 상태가 오르고 새 영입이면 적응이 앞당겨진다(부주장에는 붙지 않는다). " +
      "완장을 찬 선수의 리더십이 팀토크의 폭을 키우고, 주장이 명단에 없는 경기는 부주장이 완장을 잇는다. " +
      "2군으로 내리면 완장은 자동으로 비워진다.",
  },
  {
    name: "set_squad_number",
    label: "등번호",
    group: "전술·훈련",
    readOnly: false,
    description:
      "우리 선수의 등번호를 정한다(1~99) — 감독이 번호를 지명하거나 선수가 요구한 번호를 받아들일 때 부른다. " +
      "이미 동료가 달고 있는 번호면 반려되고 누가 달고 있는지가 돌아오므로, 그것을 감독에게 전하고 넘길지를 물은 뒤 take=true로 다시 부른다 — 되묻지 않고 바로 번호를 옮기지 않는다. " +
      "번호를 빼앗긴 선수는 자리 관례로 새 번호를 받고, 그 번호에 애착이 있던 사람이면 라커룸에 불만이 선다. " +
      "임대 나간 선수와 남의 구단 선수에게는 쓰지 않는다.",
  },
  {
    name: "set_tactics",
    label: "팀 전술 변경",
    group: "전술·훈련",
    readOnly: false,
    description:
      "팀 전술 6축과 갈래 넷을 변경한다. 축은 모두 1~5이며 3이 보통이다 — " +
      `${TACTIC_AXES.map(tacticAxisScaleText).join(" · ")}. ` +
      "갈래는 눈금이 없다 — " +
      `${TACTIC_TOGGLES.map(tacticToggleChoiceText).join(" · ")}. ` +
      "현재 값과 다른 것 중 감독이 변경을 명시한 축·갈래만 보내라. 언급하지 않은 축을 균형값이나 추천값으로 보정하지 않는다. 포메이션과 선수 배치는 이 도구로 바꾸지 않는다.",
  },
  {
    name: "set_player_tactic",
    label: "선수 전술",
    group: "전술·훈련",
    readOnly: false,
    description:
      "한 선수의 자리·역할·개인 지시 중 감독이 명시한 항목만 바꾼다. 생략한 항목은 기존 값을 유지한다. 이미 그라운드에 있는 선수만 옮기며 벤치 선수를 넣으려면 substitute를 쓴다. 자리는 move로 옮긴다 — 특정 자리로 바꾸라는 지시에만 position에 코드를 적는다. instruction은 kind를 함께 보내야 판이 움직인다 — 갈래에 담기지 않는 말이면 지역을 겨냥한 지시인지 보고 set_match_plan을 쓴다. 자연어 포메이션 변경은 get_squad로 현재 배치를 본 뒤 목표 모양에 꼭 필요한 최소 선수만 이동한다. 프리셋을 적용하거나 전원을 자동 재배치하지 않는다.",
  },
  {
    name: "set_set_piece_takers",
    label: "세트피스 키커",
    group: "전술·훈련",
    readOnly: false,
    description:
      "죽은 공을 차는 사람을 지정한다 — corner(코너)·freeKick(프리킥)·penalty(페널티) 셋을 따로 둔다. 감독이 말한 자리만 보내고 나머지는 생략한다. 지정을 풀라는 지시에는 그 자리에 null을 보낸다 — 그러면 그라운드 위 킥력 최고(페널티는 결정력·침착성·킥력이 섞인 기량 최고)가 다시 찬다. 지정은 팀 전술에 남아 다음 경기에도 이어지고, 경기 중에도 같은 도구로 바꾼다. 승부차기 순서는 이것이 아니라 경기 중 승부차기 정지점에서 정한다.",
  },
  {
    name: "exploit_point",
    label: "약점 공략",
    group: "전술·훈련",
    readOnly: false,
    description:
      "감독이 읽어낸 약점을 겨냥한다. 동시에 두 곳까지고 한쪽을 파고들면 다른 쪽이 열린다. 경기 중에만 뜻이 있다.",
  },
  {
    name: "set_match_plan",
    label: "지역 전술",
    group: "전술·훈련",
    readOnly: false,
    description:
      "감독의 자연어 세부 전술을 지역 플랜으로 만든다. band는 우리 진영(defense)·중원·상대 진영(attack)이다. 선수 한 명의 자리나 역할 지시는 set_player_tactic을, 이미 발견된 약점을 그대로 노리는 지시는 exploit_point를 쓴다. 동시에 두 곳까지고 셋째를 걸면 가장 오래된 것이 밀린다.",
  },
  {
    name: "set_training",
    label: "훈련 지정",
    group: "전술·훈련",
    readOnly: false,
    description:
      "훈련의 단일 입구 — 팀 일정 등록·비우기·개인 훈련이 모두 여기로 온다. 감독이 말한 훈련만 등록하고 빈 세션을 임의로 채우지 않는다. 같은 날 같은 슬롯은 기본 훈련을 덮어쓴다. 특정 날짜 sessions 또는 요일 반복 repeatWeekly에 오전(am)·오후(pm), 자연어 label, 효과 대상 focus(능력치 축 또는 tactical·recovery)를 지정한다. 훈련을 없애는 지시는 clear로 보낸다 — rest=true(기본)면 그 자리를 쉬는 날로 못 박아 기본 훈련이 다시 들어오지 않고, rest=false면 감독이 잡은 특별 훈련만 걷어 평소 일정으로 돌린다. from·to·dow·slot으로 범위를 좁힌다. 한 선수만 겨냥한 개인 훈련은 player로 보낸다(axis 또는 position, clear=true면 거둔다). 시즌 초 여름 휴가 중에는 훈련을 잡을 수 없다 — 감독이 휴가를 접고 부르겠다고 했을 때만 recallSquad를 함께 보낸다. 선수단은 체력을 잃고 일부는 불만을 품는다.",
  },
  {
    name: "team_talk",
    label: "팀 토크",
    group: "대화·서사",
    readOnly: false,
    description:
      "감독이 선수단 전체에 한 발화의 결과를 기록한다. outcome은 맥락 적합성·설득 근거·선수단 수용성을 보고 판정하고, intensity는 발화 강도에 맞춘다(1 담담히 ~ 3 격하게). " +
      "결과는 전원의 상태를 움직이고, 아직 겉도는 새 영입에게 특히 크게 남는다.",
  },
  {
    name: "talk_to_player",
    label: "선수 면담",
    group: "대화·서사",
    readOnly: false,
    description:
      "감독과 선수 개인의 면담 결과를 기록한다. 감독이 그 선수에게 건넨 말이 있을 때만 쓴다 — 이름을 부르기만 한 말은 부름이지 면담이 아니다. " +
      "outcome은 맥락 적합성·설득 근거·대상 수용성을 보고 판정한다. 그 선수에게 불만 이슈가 있으면 어떤 결과로든 해소된다. " +
      "새로 영입해 아직 적응 중인 선수는 면담으로 적응이 앞당겨진다(나쁜 결과면 늦춰진다) — 그 무게는 settling에 적는다.",
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
      "회견을 거절하거나 자리를 피했으면 decline: true.",
  },
  {
    name: "respond_to_approach",
    label: "찾아온 사람 응대",
    group: "대화·서사",
    readOnly: false,
    description:
      "먼저 열린 자리에 감독이 답한 결과를 기록한다(스냅샷의 <approach>에 화자와 사실이 실려 있다 — 없으면 쓰지 마라). " +
      "자리가 열려 있으면 지목된 화자로 장면을 열되 사실을 그대로 읽지 말고 그 사람의 말로 옮겨라. 감독이 아직 답하지 않은 턴에는 그 사람의 말까지만 쓰고 부르지 않는다. " +
      "감독의 발화를 stance 하나로 옮긴다: defend(감싼다) · own(책임을 진다) · criticise(날을 세운다) · bold(도발) · deflect(말을 아낀다). 자리를 주지 않고 돌려보냈으면 decline: true. " +
      "구단주가 건 조건을 두고 감독이 되물었으면 counter에 싣는다 — 기한을 늘려 달라면 extendDays, 조건을 낮춰 달라면 relax: true. 한 차례뿐이고 얼마나 물러서는지는 구단주가 정한다. " +
      "압력이 연 자리는 압력만 되돌린다 — 불만은 talk_to_player·승격·선발로만 풀린다. " +
      "감독직 면접 자리에서는 답이 제안 조건을 정한다 — own·defend는 기본 조건, bold는 연봉·이적 예산 약속을 흥정 천장까지 올리고 흥정 기회를 태우며, criticise·deflect·decline은 제안 없이 문을 닫는다.",
  },
  {
    name: "substitute",
    label: "선수 교체",
    group: "경기",
    readOnly: false,
    description:
      "경기 정지점에서 우리 팀 선수를 교체한다. out에는 나가는 선수, in에는 들어오는 벤치 선수를 이름으로 적는다.",
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
      "£10k 미만의 식사·회식·택시 같은 일상 비용은 기록하거나 금액을 올려 잡지 않는다. 원장에 들어가 월간 보고서와 PSR에 그대로 반영된다.",
  },
  {
    name: "adjust_transfer_budget",
    label: "이적 예산 조정",
    group: "재정",
    readOnly: false,
    description:
      "구단주·보드가 이적 예산을 늘리거나 줄인다(delta는 음수도 가능). 자본 이동이라 손익·PSR에는 잡히지 않고, PSR로 동결된 예산은 이 도구로 풀 수 없다 — 매각이 먼저다. " +
      "매출이 늘어난 일과 선수를 판 돈은 여기로 오지 않는다. 한도는 하루 누적이다.",
  },
  {
    name: "request_board",
    label: "보드에 요청",
    group: "재정",
    readOnly: false,
    description:
      "감독이 보드에 무엇을 달라고 건다 — 이적 예산 증액(transfer-budget) · 영입 승인(signing) · 주급 한도 상향(wage-room) · 구장 증설(stadium). " +
      "감독이 부른 값을 그대로 amount에 실어라(예산·주급·이적료는 금액, 구장은 좌석 수) — 액수를 말하지 않았으면 지어내지 말고 물어라. " +
      "signing은 예산 위의 선수 하나를 두고 묻는 종류다: 그 선수를 playerId에 함께 실어라(이름 그대로 된다). 승인분은 그 선수 영입에만 쓰인다. " +
      "접수까지가 이 도구의 일이다: 답은 며칠 뒤 코어가 정해 승인·부분 승인·조건부 승인·거절과 금액으로 스냅샷에 실린다. " +
      "이 턴에는 요청을 올린 장면까지만 쓰고 보드의 답을 앞질러 쓰지 마라. 답이 온 날은 그 값 그대로 말하고, 왜 그렇게 답했는지는 잔고·급여 비중·보드 평판으로 옮겨라. " +
      "조건부 승인이면 조건과 기한이 스냅샷에 선다 — 충족도 만료도 코어가 판정하므로 그 결과 역시 앞질러 쓰지 마라. " +
      "답을 기다리거나 조건이 걸린 요청이 있거나 같은 안건을 최근에 물었으면 반려된다.",
  },
  {
    name: "fund_transfer_budget",
    label: "사재 출연",
    group: "재정",
    readOnly: false,
    description:
      "감독의 지갑에서 구단 이적 예산으로 사재를 넣는다 — 구단 돈이 아니다. " +
      "부른 금액을 그대로 amount에 실어라(£). 액수를 말하지 않았으면 물어라. " +
      "지갑과 시즌 남은 한도는 스냅샷에 있고, 넘겨 부르면 한도까지만 나간다. 되돌릴 수 없다.",
  },
  {
    name: "pay_player_bonus",
    label: "사재 보너스",
    group: "재정",
    readOnly: false,
    description:
      "감독의 사재로 우리 선수 한 명에게 보너스를 준다 — 사기가 오른다. " +
      "눈금은 그 선수 주급의 배수다: 4주치 미만은 반려, 12주치에서 멈춘다. 선수당 시즌 1회·시즌 3명.",
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
    name: "set_ticket_price",
    label: "티켓 가격",
    group: "재정",
    readOnly: false,
    description:
      "홈 경기 티켓 값을 감독이 매긴다 — price는 표 한 장의 금액(£)이다. " +
      '지금 값·기준가·부를 수 있는 폭은 get_finance가 준다: 감독이 "10% 올려"라고 하면 그 값을 읽어 계산해 넣고, 폭 밖이면 잘려 들어가므로 실제로 선 값을 결과에서 읽어 말해라. ' +
      "올리면 관중이 줄고 내리면 관중이 는다 — 기준가 근처가 수입이 가장 큰 자리라, 표가 모자라 늘 만석이던 구단만 올려서 더 번다. " +
      "시즌권과 예매가 이미 나가 있어 30일에 한 번만 다시 매긴다.",
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
      "playerId를 주면 능력치·컨디션·계약·배치에 부상 이력과 이번 시즌 경고 누적·이동 이력까지 붙은 상세 카드가 나온다 — 감독이 특정 선수를 두고 물으면 그 선수를 논하기 전에 먼저 호출한다.",
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
      "감독의 커리어 — 이번 시즌 진행 상황, 지난 시즌들의 순위·전적·보드 평가, 트로피, 업적, 맡은 팀이 받은 리그 시상. " +
      "지나간 시즌의 순위표·우승자·감독 팀의 경기는 get_history가 낸다.",
  },
  {
    name: "get_history",
    label: "역대 기록 조회",
    group: "조회",
    readOnly: true,
    description:
      "지나간 시즌의 장부를 읽는다. season으로 그 시즌의 우승자와 우리 성적을, season+competition으로 그 시즌 그 대회의 최종 순위표(녹아웃은 우승·준우승)를 본다. " +
      "team이면 그 구단의 역대 — 우승 횟수·한 시즌 최다 승점·최다 득점·최고 순위·그 구단 소속의 리그 시상. player면 그 선수의 통산과 받은 상(은퇴한 선수도 찾는다). " +
      "competition만 주면 그 대회의 역대 우승이 시즌마다 한 줄로 온다. 아무것도 주지 않으면 지나간 시즌 목록이 최근부터 온다. " +
      "지난 시즌을 두고 순위·우승·구단 역사·역대 최다를 물으면 지어내지 말고 이걸 부른다. " +
      "장부에 남은 지난 시즌 경기는 감독 팀의 것뿐이다 — 남의 팀끼리의 지난 시즌 스코어는 없고, 없는 것은 없다고 답한다.",
  },
  {
    name: "accept_manager_offer",
    label: "감독직 수락",
    group: "진행",
    readOnly: false,
    description:
      "받은 감독직 제안을 수락한다 — 그날부로 그 구단의 감독이 된다. " +
      "offer에는 제안 id나 구단 이름을 적는다. 감독이 받겠다고 분명히 말했을 때만 부른다: 어느 자리를 고를지는 감독의 것이고, 제안은 기한이 지나면 사라진다. " +
      "부임하면 앞 구단의 보드 경고는 지워지고 시즌 중이어도 그 자리에서 이어간다 — 순위표는 부임 전 경기까지 포함한 그 구단의 성적이다. " +
      "재직 중에도 열린다 — 보드의 재계약(자리는 그대로다), 다른 구단의 접근, 두드려 얻은 자리. 뒤의 둘은 그날로 옮기고 새 구단이 지금 구단에 보상금을 문다.",
  },
  {
    name: "counter_manager_offer",
    label: "감독직 흥정",
    group: "진행",
    readOnly: false,
    description:
      "받은 감독직 제안에 조건을 되부른다 — 연봉(salary)이나 이적 예산 약속(transferBudget), 또는 둘 다. " +
      "보드는 평판이 문턱을 넘는 만큼만 물러서고 천장에서 멈춘다 — 제시액 아래로 내려 부를 수는 없다. " +
      "흥정은 제안마다 한 번뿐이라 되부른 뒤에는 수락 여부만 남는다. 감독이 조건을 두고 분명히 요구했을 때만 부른다.",
  },
  {
    name: "apply_manager_job",
    label: "감독직 지원",
    group: "진행",
    readOnly: false,
    description:
      "최근 공석(경질 뒤 14일 안)인 구단에 먼저 지원한다 — 공석 명부는 상태 스냅샷에 선다. " +
      "평판이 그 등급의 문턱을 넘으면 제안이 아니라 그 구단 구단주와 마주 앉는 면접 자리가 서고, 못 미치면 거절당한다. " +
      "결과에 실려 온 사실 카드로 그 턴에 면접 장면을 열되 제안은 말하지 마라 — 조건은 감독이 respond_to_approach로 답한 뒤에 선다. " +
      "재직 중에 두드리면 자리가 선 날 보드 평판이 깎이고 기자가 묻는다 — 감독이 옮길 뜻을 밝혔을 때만 부른다. " +
      "열린 제안이나 답을 기다리는 사람이 있는 동안에는 지원할 수 없고, 이번 임기에 이미 이야기가 오간 구단은 다시 두드릴 수 없다.",
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
      "타 팀 선수에게 스카우트를 파견한다. 며칠 뒤 보고서가 오면 실행 계열 능력치는 거의 정확해지고 판단 계열에는 오차가 남으며, 잠재력은 구간으로 잡힌다 — 같은 선수에게 다시 보낼수록 구간이 좁아진다. 진지한 영입 검토나 상대 핵심 분석에 사용하며 동시 파견 한도가 있다.",
  },
  {
    name: "scout_mission",
    label: "스카우트 임무",
    group: "조회",
    readOnly: false,
    description:
      "이름 대신 조건으로 스카우트를 내보낸다 — 대회(competition)·자리(position)·나이 상하한(minAge·maxAge)·관측 시장가 상한(maxValue) 중 감독이 말한 것만 싣는다. 대회를 비우면 5대 리그 1·2부 전체가 풀이다. " +
      `${MISSION_DAYS}일 뒤 후보 ${MISSION_CANDIDATES}명이 카드로 온다. ` +
      "감독이 이름을 대지 않고 조건으로 선수를 찾아오라고 하면 search_players가 아니라 이것을 부른다. " +
      "돌아온 후보는 직접 상대해 본 선수만큼만 보인다 — 능력치와 값에 오차가 남고 잠재력은 넓은 구간이다. 그 중 하나를 더 알아야 하면 그 이름으로 scout_player를 보낸다. " +
      "동시 파견 한도를 scout_player와 나눠 쓴다 — 자리가 없으면 나가지 못하고 대기로 남는다. 자리가 난 뒤 다시 불러야 나간다.",
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
    name: "send_offer",
    label: "오퍼",
    group: "이적",
    readOnly: false,
    description:
      "이적 오퍼를 넣는다. 임대는 fee가 임대료, weeklyWage가 우리(loan)나 그쪽(loan_out)이 낼 주급이다. 넣기 전에 deal_odds로 확률을 확인하라. 답은 며칠 뒤에 오고 같은 조건을 반복하면 상대가 지친다. pitch는 감독이 말로 든 설득 논거를 kind로 옮긴 것이고, 목록에 없는 이야기는 other로 넣으면 서사에만 남는다. 확인된 논거는 확률이 아니라 판정 여유를 연다. 감독이 금액만 말했으면 무엇을 더 걸 수 있는지 먼저 물어라. paymentYears로 이적료를 2~4년 분할로 부를 수 있다 — 예산이 모자랄 때의 길이고, 상대는 늦게 오는 돈을 깎아 보므로 같은 확률을 원하면 총액을 올려 불러야 한다. 계약이 반년 이하 남은 타 구단 선수에게 fee=0을 부르면 그것이 사전 계약이다 — 이적창과 이적 예산을 지나지 않고, 판정하는 것은 구단이 아니라 선수 하나이며, 합의하면 그가 다음 7월 1일에 온다(지금 오지 않는다).",
  },
  {
    name: "respond_offer",
    label: "오퍼 판정",
    group: "이적",
    readOnly: false,
    description:
      "상대가 넣은 오퍼에 감독의 뜻대로 답한다 (accept·counter·reject). 우리가 넣은 오퍼에 대한 상대의 답은 당신이 판정하지 않는다 — 그 자리는 이미 끝나 상태 스냅샷의 📨 줄에 있고, 당신은 그것을 장면으로 전한다. 감독이 답을 정한 협상은 서사만 쓰지 말고 이 도구로 기록해야 다음 단계로 간다. deal_odds의 확률과 근거를 앵커로 삼고 note에 한 줄을 남긴다. counter는 우리가 값을 올려 부르는 것이고(받은 값 초과), paymentYears를 얹으면 같은 금액을 분할로 되부르는 것이다 — 총액 한도는 그대로 걸리고 분할은 그 위의 흥정이다.",
  },
  {
    name: "accept_deal",
    label: "계약 확정",
    group: "이적",
    readOnly: false,
    description:
      "합의된 협상을 다음 단계로 넘긴다. 첫 호출은 계약이 아니라 메디컬이다 — 검진 날짜가 잡히고, 통과하면 그날 코어가 이적료·계약·재정·소속을 함께 반영한다. 이 도구를 부른 턴에 도장·입단식·발표·기자회견을 쓰지 말고, 검진 결과를 기다리는 동안 다시 부르지 않는다. 소견이 나온 뒤 다시 부르면 그것은 소견을 알고도 데려오겠다는 강행이다.",
  },
  {
    name: "set_transfer_list",
    label: "이적 리스트",
    group: "이적",
    readOnly: false,
    description:
      "우리 선수를 이적 리스트에 올리거나 뺀다 — 감독이 '이 선수는 팔겠다'고 할 때 여기로 온다. askingPrice(호가)를 생략하면 코어의 요구가를 쓴다. 등재하면 그 선수를 노리는 오퍼가 들어오기 시작하고, 비싸게 부를수록 더디 붙는다.",
  },
  {
    name: "respond_transfer_request",
    label: "이적 요청 응답",
    group: "이적",
    readOnly: false,
    description:
      "선수가 낸 이적 요청에 답한다 — 요청이 서 있는 선수에게만 부른다. 감독이 먼저 팔기로 한 것은 set_transfer_list다. " +
      "accept는 그 선수를 이적 리스트에 올리는 것이고 값을 포기하는 결정이다 — askingPrice를 높이 불러도 코어가 요청 할인선까지 끌어내린다. " +
      "refuse는 요청을 걷지 못한다 — 불만은 남고, 라커룸과 보드가 그 자리에서 움직이며, 거부한 사실은 다음 회견에 실린다. " +
      "감독이 답을 정하지 않았으면 부르지 말고 먼저 물어라. note에 감독이 밝힌 한 줄을 남긴다.",
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
      "우리 선수와의 계약을 일방 해지한다 (방출). 잔여 계약 주급 전액을 즉시 물고 원장에 남아 PSR에 잡힌다. " +
      "합의로 깎으려면 open_release가 먼저다. 감독의 확인을 받고 호출하라.",
  },
  {
    name: "exercise_buyback",
    label: "되사기 행사",
    group: "이적",
    readOnly: false,
    description:
      "우리가 판 선수에게 걸어 둔 되사기 조항을 행사해 정해진 값에 그 자리에서 데려온다. 협상도 메디컬도 없다 — 권리라 상대는 거부할 수 없다. 쓸 수 있는 권리가 있으면 턴 블록에 서므로, 없는 선수에게 부르지 마라. 이적창이 열려 있고 이적 예산이 조항 값을 덮을 때만 선다.",
  },
  {
    name: "recall_loan",
    label: "임대 복귀",
    group: "이적",
    readOnly: false,
    description:
      "임대 보낸 우리 선수를 기한 전에 불러들인다. 돌아온 선수는 2군으로 들어온다. 내보내는 임대는 send_offer(kind=loan_out), 데려오는 임대는 send_offer(kind=loan)다.",
  },
  {
    name: "open_renewal",
    label: "재계약 제안",
    group: "이적",
    readOnly: false,
    description:
      "우리 선수에게 재계약을 제안한다 (주급·연수). 이적창과 무관하게 언제든 가능하고, 상대는 구단이 아니라 선수 본인이다. 제안 전에 deal_odds(kind=renew)로 확률을 확인하라. 선수가 주급을 더 요구하면 그 값으로 다시 제안하면 된다.",
  },
  {
    name: "open_release",
    label: "해지 제안",
    group: "이적",
    readOnly: false,
    description:
      "우리 선수에게 합의 해지를 제안한다 — severance는 제시 정산금이고 상대는 선수 본인이다. 이적창과 무관하다. " +
      "제안 전에 deal_odds(kind=release)로 확률을 확인하라. 선수가 정산금을 더 부르면 그 값으로 다시 제안하면 된다. " +
      "합의가 깨지면 남는 길은 잔여 주급 전액을 무는 release_player뿐이다. " +
      "정산금은 paymentYears로 2~4년 분할할 수 있다 — 일방 해지는 언제나 전액 일시금이다.",
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
