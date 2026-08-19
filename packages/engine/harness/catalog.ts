import { HISTORY_CHAR_KEEP } from "../src/core/history-window";
import { defineHarness, type Harness } from "./harness";

/**
 * 하네스 서술자 — **밴드 숫자가 사는 유일한 자리** (→ `docs/simulation/balance-harness.md`).
 *
 * `why`는 그 구간이 왜 그 자리인지의 한 줄이고, 긴 근거는 `doc`이 가리키는 문서 절이
 * 쥔다. 여기에 없는 숫자를 하네스 본체가 직접 적으면 기댓값이 다시 두 곳으로 갈린다.
 */

const MATCH = "docs/simulation/match.md §7";
const FINANCE = "docs/simulation/finance.md §10";
const HISTORY = "docs/llm/agents.md §5-1";

export const WORLD_SEASON = defineHarness({
  id: "world-season",
  what: "전체 세계 EPL 한 시즌 — 득점·슈팅 분포 · 승점 곡선 · 카드",
  doc: MATCH,
  cost: "시드당 수십 초 × 3시드",
  // prettier-ignore
  bands: [
    { metric: "리그 평균 슈팅/경기", role: "reference", min: 24, max: 26, why: "실제 1부의 양 팀 합" },
    { metric: "리그 평균 기회 xG/경기", role: "measure", why: "최종 득점과 같은 눈금이어야 한다" },
    { metric: "결정력 반영 기대 득점/경기", role: "measure", why: "기회 xG와 같은 눈금이어야 한다" },
    { metric: "리그 평균 득점/경기", role: "reference", min: 2.7, max: 2.9, why: "실제 1부" },
    { metric: "총득점 분산", role: "measure", why: "실제는 분산 ≈ 평균 — 평균만으로는 닮았는지 알 수 없다" },
    { metric: "홈 득점/경기", role: "reference", min: 1.5, max: 1.6, why: "실제 1부" },
    { metric: "원정 득점/경기", role: "reference", min: 1.2, max: 1.35, why: "실제 1부" },
    { metric: "홈승 비율", role: "reference", min: 0.42, max: 0.46, unit: "ratio", why: "실제 1부" },
    { metric: "무승부 비율", role: "reference", min: 0.22, max: 0.26, unit: "ratio", why: "실제 1부" },
    { metric: "원정승 비율", role: "reference", min: 0.3, max: 0.34, unit: "ratio", why: "실제 1부" },
    { metric: "클린시트 비율", role: "reference", min: 0.27, max: 0.32, unit: "ratio", why: "팀-경기 단위 — 경기 단위로 세면 두 배가 된다" },
    { metric: "총득점 0골 비율", role: "reference", min: 0.07, max: 0.09, unit: "ratio", why: "실제 1부의 스코어 분포" },
    { metric: "총득점 1골 비율", role: "reference", min: 0.16, max: 0.18, unit: "ratio", why: "실제 1부의 스코어 분포" },
    { metric: "총득점 2골 비율", role: "reference", min: 0.21, max: 0.23, unit: "ratio", why: "실제 1부의 스코어 분포" },
    { metric: "총득점 3골 비율", role: "reference", min: 0.19, max: 0.21, unit: "ratio", why: "실제 1부의 스코어 분포" },
    { metric: "총득점 4골 비율", role: "reference", min: 0.14, max: 0.16, unit: "ratio", why: "실제 1부의 스코어 분포" },
    { metric: "총득점 5골 비율", role: "reference", min: 0.08, max: 0.1, unit: "ratio", why: "실제 1부의 스코어 분포" },
    { metric: "총득점 6골 비율", role: "reference", min: 0.04, max: 0.05, unit: "ratio", why: "실제 1부의 스코어 분포" },
    { metric: "총득점 7골+ 비율", role: "reference", min: 0.02, max: 0.03, unit: "ratio", why: "실제 1부의 스코어 분포" },
    { metric: "팀득점 0골 비율", role: "reference", min: 0.26, max: 0.29, unit: "ratio", why: "실제 1부의 팀별 득점 분포" },
    { metric: "팀득점 1골 비율", role: "reference", min: 0.31, max: 0.34, unit: "ratio", why: "실제 1부의 팀별 득점 분포" },
    { metric: "팀득점 2골 비율", role: "reference", min: 0.22, max: 0.24, unit: "ratio", why: "실제 1부의 팀별 득점 분포" },
    { metric: "팀득점 3골 비율", role: "reference", min: 0.09, max: 0.11, unit: "ratio", why: "실제 1부의 팀별 득점 분포" },
    { metric: "팀득점 4골+ 비율", role: "reference", min: 0.03, max: 0.05, unit: "ratio", why: "실제 1부의 팀별 득점 분포" },
    { metric: "팀당 슈팅/경기", role: "measure", why: "위 양 팀 합의 절반 — 분산과 함께 읽는다" },
    { metric: "팀당 슈팅 분산", role: "measure", why: "슈팅이 몇몇 경기에 몰리는지" },
    { metric: "승점 1위", role: "reference", min: 80, max: 96, unit: "score", why: "실제 1부 우승 승점(84~95)에 시드 편차를 더한 폭" },
    { metric: "승점 4위", role: "reference", min: 68, max: 74, unit: "score", why: "실제 1부" },
    { metric: "승점 10위", role: "reference", min: 45, max: 52, unit: "score", why: "실제 1부" },
    { metric: "승점 17위", role: "reference", min: 34, max: 40, unit: "score", why: "실제 1부" },
    { metric: "승점 최하위", role: "reference", min: 20, max: 28, unit: "score", why: "실제 1부" },
    { metric: "옐로/경기", role: "reference", min: 3.3, max: 3.9, why: "실제 1부" },
    { metric: "레드/경기", role: "reference", min: 0.15, max: 0.25, why: "실제 1부" },
    { metric: "감독 팀 순위", role: "measure", unit: "score", why: "지시하지 않는 감독의 성적 — 목표값을 두지 않는다" },
    { metric: "감독 팀 승점", role: "measure", unit: "score", why: "지시하지 않는 감독의 성적 — 목표값을 두지 않는다" },
    { metric: "리그 경기 수", role: "measure", unit: "count", why: "시즌을 끝까지 돌았는지 — 380이어야 한다" },
  ],
});

export const AI_ROTATION = defineHarness({
  id: "ai-rotation",
  what: "AI 스쿼드의 체력 분포와 로테이션 문턱 발동률",
  doc: MATCH,
  cost: "world-season과 같은 시즌을 나눠 쓴다",
  // prettier-ignore
  bands: [
    { metric: "표본 (팀 × 경기일)", role: "measure", unit: "count", why: "감독 경기가 시작되는 순간의 리그를 그대로 읽은 횟수" },
    { metric: "선발 평균 체력", role: "measure", why: "그날 서는 열한 명의 체력" },
    { metric: "1군 체력 ~39 비율", role: "measure", unit: "ratio", why: "탈진 문턱 아래" },
    { metric: "1군 체력 40~59 비율", role: "measure", unit: "ratio", why: "탈진 문턱 위, 피로 문턱 아래" },
    { metric: "1군 체력 60~79 비율", role: "measure", unit: "ratio", why: "피로 문턱이 걸리기 시작하는 구간" },
    { metric: "1군 체력 80~99 비율", role: "measure", unit: "ratio", why: "쉬고 돌아온 몫" },
    { metric: "1군 체력 100 비율", role: "measure", unit: "ratio", why: "한 번도 뛰지 않은 몫" },
    { metric: "피로 문턱↑ 가용 선발 (팀·경기일당)", role: "measure", why: "로테이션이 판단할 기회가 생긴 횟수 — 부상·정지는 뺀다" },
    { metric: "그중 로테이션된 비율", role: "measure", unit: "ratio", why: "문턱 셋이 동시에 걸려야 해서 깊이가 얕은 팀은 통째로 불발한다" },
    { metric: "로테이션 중 탈진 문턱 위 비율", role: "measure", unit: "ratio", why: "문턱 셋 갈래가 확실히 걸린 몫 — 아래는 두 갈래를 밖에서 가를 수 없다" },
  ],
});

export const ASSIST_RATE = defineHarness({
  id: "assist-rate",
  what: "골에 도움이 붙는 비율",
  doc: MATCH,
  cost: "축소 세계 6시드 · 수 초",
  // prettier-ignore
  bands: [
    { metric: "골", role: "measure", unit: "count", why: "골이 없으면 시험이 성립하지 않는다" },
    { metric: "도움", role: "measure", unit: "count", why: "빈 칸이 아닌 도움만 센다" },
    { metric: "골 대비 도움 비율", role: "guard", min: 0.35, unit: "ratio", why: "설계값 68%(`ASSIST_RATE`)가 만드는 분포. 표본이 작아 하한만 넉넉히 잡는다 — 도움이 사라지는 회귀는 `assist-record.test.ts`가 0이 아님으로 못 박는다" },
  ],
});

export const SEGMENT_SHOTS = defineHarness({
  id: "segment-shots",
  what: "구간 시뮬의 경기당 슈팅이 패킷 기대 슈팅과 같은 눈금인가 — 끊는 횟수와 무관하게",
  doc: "docs/simulation/match.md §1.4",
  cost: "구간 시뮬 1,600경기 · 40초쯤",
  // prettier-ignore
  bands: [
    { metric: "패킷 기대 슈팅", role: "measure", why: "양 팀 합 — 실측이 모여야 할 자리" },
    { metric: "경기당 슈팅", role: "measure", why: "정지점까지 굴린 보통의 진행" },
    { metric: "패킷 대비 배율", role: "guard", min: 0.985, max: 1.015, unit: "ratio", why: "발생률이 패킷의 선수×경로 기대 슈팅 `/90`이라 90분을 한 번 굴리면 기대치로 모인다 — 벗어나면 밸런스 손잡이가 서 있는 눈금이 감독의 개입 횟수를 탄다" },
    { metric: "5분씩 끊었을 때 배율", role: "guard", min: 0.985, max: 1.015, unit: "ratio", why: "구간이 서너 배로 쪼개져도 총량은 같아야 한다 — 정지점마다 시계가 되감기면 여기가 먼저 부푼다" },
    { metric: "경기당 구간 수", role: "measure", unit: "count", why: "되감김의 크기는 이 횟수에 비례한다" },
    { metric: "경기당 득점", role: "measure", why: "슈팅 총량이 내려가면 함께 내려간다" },
    { metric: "경기당 기회 xG", role: "measure", why: "득점과 같은 눈금이어야 한다" },
    { metric: "경기당 카드", role: "measure", why: "카드도 같은 시계를 탄다 — 슈팅만 맞고 카드가 어긋나면 고친 곳이 시계가 아니다" },
  ],
});

export const INJURY_RATE = defineHarness({
  id: "injury-rate",
  what: "경기당 부상 건수 · 성향이 빈도에 닿는 폭",
  doc: MATCH,
  cost: "간이 시뮬 16,000판 · 수십 초",
  // prettier-ignore
  bands: [
    { metric: "경기당 부상 건수", role: "measure", why: "양 팀 합" },
    { metric: "기대 대비 배율", role: "guard", min: 0.8, max: 1.2, why: "기대 = `INJURY_CHANCE_PER_APPEARANCE` × 온필드 22명. 손잡이에서 유도하므로 눈금을 옮겨도 따라온다" },
    { metric: "유리몸 팀 배율", role: "guard", min: 1.3, why: "선발 전원 성향 2.2일 때 건강한 팀 대비 — 성향이 빈도에 닿는지" },
    { metric: "유리몸 한 명의 부상 점유율", role: "guard", min: 0.11, unit: "ratio", why: "뛴 선수(선발 11 + 교체 최대 4) 중 한 명이면 균등은 7~9%" },
  ],
});

export const FINANCE_TIER1 = defineHarness({
  id: "finance-tier1",
  what: "tier1 유저 구단의 한 시즌 살림 — 장부 손익 · 현금 · 급여 비중 · 수입",
  doc: `${FINANCE}.1`,
  cost: "전체 세계 한 시즌 · 수 분",
  // prettier-ignore
  bands: [
    { metric: "시즌 1 보고서 수", role: "guard", min: 10, unit: "count", why: "한 시즌을 다 돌지 못하면 나머지가 전부 헛값이다" },
    { metric: "연 장부 손익", role: "reference", min: -30_000_000, max: 70_000_000, unit: "money", why: "**밴드의 기준 축.** PSR 위반선(시즌 평균 −£35M) 바로 위부터, 흑자만으로 이적 예산이 무한히 불어나지 않는 선까지. 상단은 한 시즌이 12개월이 되며 +£40M에서 옮겼다 — 마지막 달이 시즌 안에서 마감되고(finance.md §7.1) 그 달이 순위·컵 상금을 진다" },
    { metric: "연 현금 순증", role: "guard", min: 85_000_000, max: 260_000_000, unit: "money", why: "이적 활동이 지배하는 축이라 밸런스를 판정하지 않는다 — 시즌이 제대로 돌았는지의 난간. 상단은 11개월 시절 천장까지의 여유(31%)를 12개월에 그대로 옮긴 값이다" },
    { metric: "연 수입", role: "guard", min: 300_000_000, unit: "money", why: "실제 상위 구단 £400–700M의 6–7할" },
    { metric: "연 지출", role: "measure", unit: "money", why: "수입과 함께 읽는다 — 손익의 분해" },
    { metric: "연 상각", role: "measure", unit: "money", why: "실제 구단은 비용의 3할 안팎" },
    { metric: "경기 달 수", role: "guard", min: 9, unit: "count", why: "프리시즌 달은 매치데이가 없어 급여 비중 대상에서 뺀다" },
    { metric: "경기 달 급여 비중 (최저)", role: "guard", min: 0.2, unit: "ratio", why: "실제 EPL 평균 ~70%의 아래쪽 폭" },
    { metric: "경기 달 급여 비중 (최고)", role: "guard", max: 0.95, unit: "ratio", why: "실제 EPL 평균 ~70%의 위쪽 폭" },
  ],
});

export const FINANCE_LEAGUES = defineHarness({
  id: "finance-leagues",
  what: "한 시즌 뒤 리그별 잔고 — 어느 리그도 구조적 적자가 아니다",
  doc: `${FINANCE}.3`,
  cost: "finance-tier1과 같은 시즌을 나눠 쓴다",
  // prettier-ignore
  bands: [
    { metric: "리그별 중간 잔고의 최소", role: "guard", min: 0, unit: "money", why: "약체 리그가 구조적 적자면 이적 시장이 왜곡된다 (불변식 1)" },
    { metric: "리그별 최저 잔고의 최소", role: "guard", min: -30_000_000, unit: "money", why: "한 구단이 파산 수준으로 가라앉지 않는 선" },
  ],
});

export const FINANCE_MULTI_SEASON = defineHarness({
  id: "finance-multi-season",
  what: "세 시즌을 굴려도 가라앉는 리그가 없다",
  doc: `${FINANCE}.3`,
  cost: "전체 세계 세 시즌 · 십수 분",
  // prettier-ignore
  bands: [
    { metric: "도달한 시즌", role: "guard", min: 4, unit: "count", why: "세 시즌은 리그가 가라앉는지 보이는 가장 짧은 창이다" },
    { metric: "리그별 중간 잔고의 최소", role: "guard", min: 0, unit: "money", why: "한 시즌은 발산을 감추기에 충분히 짧다 (불변식 1). 자유계약·시장 전용 리그는 클럽이 아니라 대상 밖" },
  ],
});

export const FINANCE_SECOND_TIER = defineHarness({
  id: "finance-second-tier",
  what: "리그전을 굴리지 않는 2부의 한 시즌 수지",
  doc: "docs/simulation/finance.md §9.5",
  cost: "전체 세계 한 시즌 · 수 분",
  // prettier-ignore
  bands: [
    { metric: "2부 구단 수", role: "guard", min: 10, unit: "count", why: "표본이 없으면 중간값이 뜻을 잃는다" },
    { metric: "2부 한 시즌 수지 중간값", role: "guard", min: -8_000_000, unit: "money", why: "균형이 아니라 **수입원의 존재**를 지킨다 — 이 선이 깨지면 매치데이 보정이 사라졌다는 뜻이다" },
  ],
});

export const AI_FITNESS = defineHarness({
  id: "ai-fitness",
  what: "한 시즌을 돈 뒤의 AI 스쿼드 체력·출전 분포",
  doc: MATCH,
  cost: "전체 세계 한 시즌 · 수 분",
  // prettier-ignore
  bands: [
    { metric: "상대 상위 14명 체력 (최저 팀)", role: "guard", min: 70, why: "라인업에 설 14명이 어느 시점에도 쓸 만해야 한다" },
    { metric: "우리와 상대의 체력 격차", role: "guard", max: 10, why: "하루 회복이 우리 팀에만 있던 시절 이 차이가 20을 넘었다" },
    { metric: "한 시즌 출전 인원 (맨시티)", role: "guard", min: 18, unit: "count", why: "열한 명이 다 뛰면 로테이션이 없는 것이다" },
  ],
});

export const AI_MARKET = defineHarness({
  id: "ai-market",
  what: "한 시즌의 AI↔AI 시장 규모 — 팀당 이적·임대와 여름 비중",
  doc: "docs/simulation/transfer.md §6",
  cost: "전체 세계 한 시즌 · 수 분",
  // prettier-ignore
  bands: [
    { metric: "총 이동", role: "measure", unit: "count", why: "이적 + 임대 — 팀당 값의 분모가 아니라 규모 그 자체" },
    { metric: "1부 팀당 이적", role: "guard", min: 1, max: 6, why: "실제 시장과 같은 자릿수" },
    { metric: "1부 팀당 임대", role: "guard", min: 0.5, max: 4, why: "실제 시장과 같은 자릿수" },
    { metric: "여름 비중", role: "guard", min: 0.5, unit: "ratio", why: "실제 시장의 여름:겨울은 7:3" },
  ],
});

export const MANAGER_MARKET = defineHarness({
  id: "manager-market",
  what: "한 시즌에 감독을 바꾸는 1부 구단 수",
  doc: "docs/simulation/transfer.md §7",
  cost: "전체 세계 한 시즌 · 수 분",
  // prettier-ignore
  bands: [
    { metric: "경질 구단 수", role: "guard", min: 5, unit: "count", why: "`SACK_CHANCE`와 문턱이 만든 빈도가 사람 사는 범위인가" },
    { metric: "경질 구단 비중", role: "guard", max: 0.5, unit: "ratio", why: "리그가 통째로 뒤집히지는 않는다" },
  ],
});

export const SQUAD_LONGEVITY = defineHarness({
  id: "squad-longevity",
  what: "15시즌을 넘긴 뒤에도 구단이 선발 XI·계약을 세우는가",
  doc: "docs/simulation/season.md §6",
  cost: "세계 하나 · 전환 15번 · 약 1분 40초",
  // prettier-ignore
  bands: [
    { metric: "클럽 수", role: "guard", min: 100, unit: "count", why: "표본이 없으면 아래 네 줄이 공허하게 통과한다 — 시드 세계의 클럽 수보다 넉넉히 아래" },
    { metric: "선발 XI가 11이 아닌 구단", role: "guard", max: 0, unit: "count", why: "열한 명을 못 세우는 구단이 하나라도 생기면 그 리그는 경기를 치를 수 없다" },
    { metric: "GK 없는 구단", role: "guard", max: 0, unit: "count", why: "골문은 대체할 자리가 없다 — 은퇴가 유스 콜업보다 빠를 때 가장 먼저 마르는 자리" },
    { metric: "보유하지 않은 선수를 가리키는 배치", role: "guard", max: 0, unit: "count", why: "은퇴·이적으로 떠난 선수가 배치에 남아 있으면 라인업이 유령을 세운다" },
    { metric: "활성 계약 없는 선수", role: "guard", max: 0, unit: "count", why: "소속과 계약은 한 쌍이다 — 갈라지면 주급도 이적료도 계산되지 않는다" },
    { metric: "구단당 평균 스쿼드 인원", role: "measure", why: "스쿼드가 말라가는지 — 지키려는 값이 아니라 재려는 값" },
    { metric: "가장 얕은 스쿼드 인원", role: "measure", unit: "count", why: "평균은 한 구단의 고갈을 감춘다" },
    { metric: "가장 얕은 GK 보유", role: "measure", unit: "count", why: "1이면 버틴 것이고 2면 숫자가 살아 있다" },
    { metric: "스쿼드 평균 나이", role: "measure", why: "은퇴와 콜업의 균형 — 해마다 오르면 언젠가 선발 XI가 깨진다" },
  ],
});

/**
 * 종합 눈금 — **그 숫자가 굴리는 것들의 분포** (`docs/data/player.md` §4).
 *
 * 종합은 화면의 숫자 하나가 아니라 시장가·주급 서열·잠재력 간격·등급 색이 함께 읽는
 * 눈금이다. 눈금을 옮기면 그 넷이 전부 따라 움직이는데, 얼마나 움직이는지는 코드를
 * 읽어서는 알 수 없다 — 세계를 하나 세워 재는 자리가 여기다. 밴드를 두지 않는 이유도
 * 같다: 재려는 값이지 지키려는 값이 아니다.
 */
export const OVERALL_SCALE = defineHarness({
  id: "overall-scale",
  what: "종합이 굴리는 것들의 분포 — 자리별 평균 · 축 범위 밖 · 시장가 · 주급 · 잠재력 간격",
  doc: "docs/data/player.md §4",
  cost: "세계 하나 · 시드당 몇 초 × 2시드",
  // prettier-ignore
  bands: [
    { metric: "선수 수", role: "measure", unit: "count", why: "전 세계" },
    { metric: "EPL 인원", role: "measure", unit: "count", why: "돈은 EPL만 잰다 — 전 세계에 계약 조회를 걸면 몇 분이 된다" },
    { metric: "종합 평균", role: "measure", why: "" },
    { metric: "종합 p10", role: "measure", unit: "score", why: "" },
    { metric: "종합 p50", role: "measure", unit: "score", why: "" },
    { metric: "종합 p90", role: "measure", unit: "score", why: "" },
    { metric: "종합 p99", role: "measure", unit: "score", why: "" },
    { metric: "종합 최대", role: "measure", unit: "score", why: "" },
    { metric: "자리별 평균 GK", role: "measure", why: "자리 사이의 폭 — 가중 평균이 자리를 기울이는지" },
    { metric: "자리별 평균 CB", role: "measure", why: "" },
    { metric: "자리별 평균 FB", role: "measure", why: "" },
    { metric: "자리별 평균 DM", role: "measure", why: "" },
    { metric: "자리별 평균 CM", role: "measure", why: "" },
    { metric: "자리별 평균 AM", role: "measure", why: "" },
    { metric: "자리별 평균 W", role: "measure", why: "" },
    { metric: "자리별 평균 CF", role: "measure", why: "" },
    { metric: "자리별 평균 ST", role: "measure", why: "" },
    { metric: "축 범위 위로 벗어난 비율", role: "measure", unit: "ratio", why: "종합이 어느 축보다 높은 선수" },
    { metric: "축 범위 아래로 벗어난 비율", role: "measure", unit: "ratio", why: "종합이 어느 축보다 낮은 선수" },
    { metric: "등급 top(85+) 비율", role: "measure", unit: "ratio", why: "화면의 등급 색이 읽는 문턱" },
    { metric: "등급 strong(75+) 비율", role: "measure", unit: "ratio", why: "" },
    { metric: "등급 solid(65+) 비율", role: "measure", unit: "ratio", why: "" },
    { metric: "등급 low 비율", role: "measure", unit: "ratio", why: "" },
    { metric: "시장가 p50", role: "measure", unit: "money", why: "" },
    { metric: "시장가 p90", role: "measure", unit: "money", why: "" },
    { metric: "시장가 최대", role: "measure", unit: "money", why: "" },
    { metric: "시장가 총액", role: "measure", unit: "money", why: "EPL 전체" },
    { metric: "희망 주급 p50", role: "measure", unit: "wage", why: "" },
    { metric: "희망 주급 p90", role: "measure", unit: "wage", why: "" },
    { metric: "희망 주급 최대", role: "measure", unit: "wage", why: "" },
    { metric: "실제 주급 p50", role: "measure", unit: "wage", why: "" },
    { metric: "실제 주급 p90", role: "measure", unit: "wage", why: "" },
    { metric: "실제 주급 최대", role: "measure", unit: "wage", why: "" },
    { metric: "실제 주급 총액", role: "measure", unit: "money", why: "EPL 전체 · 주 단위" },
    { metric: "잠재력 간격 p50", role: "measure", unit: "score", why: "" },
    { metric: "잠재력 간격 p90", role: "measure", unit: "score", why: "" },
    { metric: "잠재력 간격 최대", role: "measure", unit: "score", why: "" },
    { metric: "잠재력 대역 상한 초과 비율", role: "measure", unit: "ratio", why: "`docs/data/player.md` §6.5의 나이별 상한 — 못 박는 것은 `seed-join.test.ts`다" },
  ],
});

export const HISTORY_WINDOW = defineHarness({
  id: "history-window",
  what: "평시 이력의 창 — 상한·잔량이 몇 턴인가 · 창이 미끄러지는 빈도 · 압축 뒤 잔량",
  doc: HISTORY,
  cost: "세계 하나 + 합성 이력 400턴 — 수 초",
  // prettier-ignore
  bands: [
    { metric: "이력 창 (턴)", role: "reference", min: 100, max: 220, unit: "count", why: "상한 ÷ 실측 턴당 글자 — 시즌을 가로지르는 이야기가 창 안에 남아야 한다" },
    { metric: "압축 뒤 이력 (턴)", role: "reference", min: 30, max: 80, unit: "count", why: "잔량 ÷ 실측 턴당 글자" },
    { metric: "압축 주기 (턴)", role: "measure", unit: "count", why: "(상한 − 잔량) ÷ 턴당 글자 — 요약 블록이 이만큼마다 한 번 무효가 된다" },
    { metric: "압축 뒤 이력 글자", role: "guard", max: HISTORY_CHAR_KEEP, unit: "count", why: "잔량 그것 — 넘으면 압축이 제 일을 하지 못한 것이다" },
    { metric: "창이 미끄러진 턴 비율", role: "guard", max: 0.2, unit: "ratio", why: "6턴 스텝이라 정상은 1/6 — 매 턴 미끄러지면 이력 캐시가 한 번도 적중하지 않는다" },
    { metric: "렌더 배율", role: "reference", min: 1, max: 1.3, unit: "ratio", why: "코어가 세는 turn.text와 프롬프트에 실리는 형태의 비 — 이보다 벌어지면 글자 상한이 뜻을 잃는다" },
    { metric: "잔량의 최소 캐시 프리픽스 배수", role: "guard", min: 1, unit: "ratio", why: "그 아래면 압축 직후 이력 캐시가 아예 안 걸린다 (models.md §1)" },
  ],
});

/** `pnpm balance --list`가 읽는 목록 — 새 하네스를 여기 넣지 않으면 목록에 서지 않는다 */
export const HARNESSES: readonly Harness[] = [
  WORLD_SEASON,
  AI_ROTATION,
  ASSIST_RATE,
  SEGMENT_SHOTS,
  INJURY_RATE,
  FINANCE_TIER1,
  FINANCE_LEAGUES,
  FINANCE_SECOND_TIER,
  FINANCE_MULTI_SEASON,
  AI_FITNESS,
  AI_MARKET,
  MANAGER_MARKET,
  SQUAD_LONGEVITY,
  OVERALL_SCALE,
  HISTORY_WINDOW,
];
