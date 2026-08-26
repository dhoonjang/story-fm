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
const PROMPTS = "docs/llm/prompts.md §7";

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
    { metric: "리그 평균 득점/경기", role: "reference", min: 2.75, max: 3.05, why: "실제 1부 최근 다섯 시즌 2.7~3.3, 평균 2.9" },
    { metric: "총득점 분산", role: "measure", why: "실제는 분산 ≈ 평균 — 평균만으로는 닮았는지 알 수 없다" },
    { metric: "홈 득점/경기", role: "reference", min: 1.5, max: 1.7, why: "실제 1부 — 총득점의 55% 안팎이 홈에서 난다. **지금은 벗어나 있다** — 홈 이점이 슈팅 노출 한 줄뿐이라 (match.md §9)" },
    { metric: "원정 득점/경기", role: "reference", min: 1.2, max: 1.4, why: "실제 1부 — 홈의 0.78~0.82배. 위와 같은 이유로 지금은 위끝에 선다" },
    { metric: "홈승 비율", role: "reference", min: 0.41, max: 0.48, unit: "ratio", why: "실제 1부 최근 네 시즌 41~48%" },
    { metric: "무승부 비율", role: "reference", min: 0.2, max: 0.26, unit: "ratio", why: "실제 1부 최근 네 시즌 20~25%" },
    { metric: "원정승 비율", role: "reference", min: 0.29, max: 0.36, unit: "ratio", why: "실제 1부 최근 네 시즌 30~36% — 홈승을 넘지 않는다" },
    { metric: "클린시트 비율", role: "reference", min: 0.25, max: 0.32, unit: "ratio", why: "팀-경기 단위 — 경기 단위로 세면 두 배가 된다" },
    { metric: "총득점 0골 비율", role: "reference", min: 0.05, max: 0.085, unit: "ratio", why: "실제 1부(경기당 2.9골)의 스코어 분포 — 푸아송에 과산포 1.1~1.15가 얹힌 모양. 한 시즌 380경기라 시드마다 ±2%p는 잡음이다" },
    { metric: "총득점 1골 비율", role: "reference", min: 0.14, max: 0.19, unit: "ratio", why: "같은 분포" },
    { metric: "총득점 2골 비율", role: "reference", min: 0.2, max: 0.24, unit: "ratio", why: "같은 분포" },
    { metric: "총득점 3골 비율", role: "reference", min: 0.19, max: 0.23, unit: "ratio", why: "같은 분포" },
    { metric: "총득점 4골 비율", role: "reference", min: 0.14, max: 0.17, unit: "ratio", why: "같은 분포" },
    { metric: "총득점 5골 비율", role: "reference", min: 0.07, max: 0.11, unit: "ratio", why: "같은 분포" },
    { metric: "총득점 6골 비율", role: "reference", min: 0.03, max: 0.055, unit: "ratio", why: "같은 분포" },
    { metric: "총득점 7골+ 비율", role: "reference", min: 0.025, max: 0.045, unit: "ratio", why: "꼬리 — 실제 3~5%. 리드를 쥔 팀이 내려서지 않으면 여기가 먼저 부푼다 (`LEAD_SHOT_LOG_RATE`)" },
    { metric: "팀득점 0골 비율", role: "reference", min: 0.24, max: 0.29, unit: "ratio", why: "실제 1부의 팀별 득점 분포 (팀당 1.45골)" },
    { metric: "팀득점 1골 비율", role: "reference", min: 0.3, max: 0.35, unit: "ratio", why: "같은 분포" },
    { metric: "팀득점 2골 비율", role: "reference", min: 0.21, max: 0.25, unit: "ratio", why: "같은 분포" },
    { metric: "팀득점 3골 비율", role: "reference", min: 0.09, max: 0.13, unit: "ratio", why: "같은 분포" },
    { metric: "팀득점 4골+ 비율", role: "reference", min: 0.04, max: 0.075, unit: "ratio", why: "실제 5~6% — 앞선 팀이 내려서는 몫이 여기를 잡는다 (`LEAD_SHOT_LOG_RATE`)" },
    { metric: "세트피스 득점 비율", role: "reference", min: 0.22, max: 0.32, unit: "ratio", why: "실제 1부가 25~30%(페널티 포함) — 손잡이는 `SET_PIECE_SHOT_SHARE`·`CORNER_XG_BASE`·`PENALTY_PER_MATCH`다. 시드 편차를 양쪽으로 2%p 열어 둔다" },
    { metric: "코너·프리킥 득점/경기", role: "measure", why: "실제 1부가 0.55~0.6 — 위 비율의 큰 몫" },
    { metric: "페널티 득점/경기", role: "reference", min: 0.13, max: 0.24, why: "경기당 페널티 `PENALTY_PER_MATCH`(0.25) × 성공률(0.62~0.80) = 0.16~0.2. 시즌 380경기라 잡음이 15%다" },
    { metric: "팀당 슈팅/경기", role: "measure", why: "위 양 팀 합의 절반 — 분산과 함께 읽는다" },
    { metric: "팀당 슈팅 분산", role: "measure", why: "슈팅이 몇몇 경기에 몰리는지" },
    { metric: "승점 1위", role: "reference", min: 80, max: 100, unit: "score", why: "실제 1부 우승 승점은 보통 84~93이고 역대 최고가 100(2017-18) — 전력 곡선(`ABILITY_LOG_SLOPE`)이 여기를 세운다" },
    { metric: "승점 4위", role: "reference", min: 66, max: 75, unit: "score", why: "실제 1부 최근 다섯 시즌 66~75" },
    { metric: "승점 10위", role: "reference", min: 46, max: 58, unit: "score", why: "실제 1부 최근 다섯 시즌 48~63 — 중위권이 두터워 시즌마다 크게 흔들린다" },
    { metric: "승점 17위", role: "reference", min: 32, max: 40, unit: "score", why: "실제 1부 최근 다섯 시즌 32~38" },
    { metric: "승점 최하위", role: "reference", min: 10, max: 28, unit: "score", why: "실제 1부 최근 다섯 시즌 12~25, 역대 최저 11" },
    { metric: "옐로/경기", role: "reference", min: 3.7, max: 4.5, why: "실제 1부 — 2023년 판정 지침 뒤 4.1~4.2 (2022-23은 3.6)" },
    { metric: "레드/경기", role: "reference", min: 0.12, max: 0.25, why: "실제 1부 시즌 45~60장" },
    { metric: "옐로/경기 (감독 경기 · 구간 시뮬)", role: "measure", why: "리그 38경기 · 카드 130장이라 상대 잡음 9% — 아래 비와 함께 읽는다" },
    { metric: "옐로/경기 (타 팀 경기 · 간이 시뮬)", role: "measure", why: "리그 342경기 — 위 `옐로/경기`를 사실상 이쪽이 정한다" },
    { metric: "옐로 — 감독/타 팀", role: "measure", unit: "ratio", why: "두 시뮬의 눈금이 갈리면 벌어지는 자리. **판정은 `injury-rate`가 한다** — 38경기로는 10~20%의 어긋남이 잡음에 묻힌다" },
    { metric: "레드/경기 (감독 경기 · 구간 시뮬)", role: "measure", why: "시즌당 예닐곱 장 — 갈래를 찍기만 한다" },
    { metric: "레드/경기 (타 팀 경기 · 간이 시뮬)", role: "measure", why: "같은 갈래의 반대편" },
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
  what: "경기당 부상·카드 — 간이 시뮬과 구간 시뮬이 같은 눈금에 서는가 · 성향이 빈도에 닿는 폭",
  doc: MATCH,
  cost: "간이 시뮬 48,000판 + 구간 시뮬 12,000판 · 2분쯤",
  // prettier-ignore
  bands: [
    { metric: "경기 강도 (양 팀 평균)", role: "measure", why: "`matchIntensity` — 카드·부상 기대치가 이 배수를 탄다. 두 시뮬이 같은 값을 읽어야 한다" },
    { metric: "경기당 부상 건수 (간이)", role: "measure", why: "양 팀 합" },
    { metric: "경기당 부상 건수 (구간)", role: "measure", why: "같은 두 팀을 구간 시뮬로 굴린 값" },
    { metric: "부상 기대 대비 배율 (간이)", role: "guard", min: 0.85, max: 1.15, why: "기대 = `teamInjuryRate`(강도·성향 포함)의 양 팀 합. 손잡이에서 유도하므로 눈금을 옮겨도 따라온다" },
    { metric: "부상 기대 대비 배율 (구간)", role: "guard", min: 0.85, max: 1.15, why: "같은 기대치 — 두 시뮬이 같은 함수를 읽는지" },
    { metric: "부상 — 간이/구간", role: "guard", min: 0.88, max: 1.12, unit: "ratio", why: "**두 시뮬이 한 눈금에 서는가 — 이 하네스의 본론.** 간이 쪽은 팀당 베르누이 한 번이라 λ와 1−e^(−λ)만큼(3% 안쪽) 낮게 선다. 경기당 0.1건이라 팔당 1,300건 · 잡음 4%가 바닥이고, 밴드는 그 위의 실제 어긋남만 잡는다 — 카드 쪽이 같은 어긋남을 훨씬 날카롭게 잡는다" },
    { metric: "경기당 카드 (간이)", role: "measure", why: "양 팀 합 — 경고 + 퇴장 줄 수" },
    { metric: "경기당 카드 (구간)", role: "measure", why: "같은 두 팀을 구간 시뮬로 굴린 값" },
    { metric: "카드 기대 대비 배율 (간이)", role: "guard", min: 1, max: 1.1, why: "기대 = `teamCardRate`(카드 **사건** 수)의 양 팀 합. 실측은 장부의 **줄** 수라 두 번째 경고가 두 줄(경고+퇴장)로 세어져 4% 위에 선다 — `STRAIGHT_RED_CHANCE`·`BOOKED_AGAIN_WEIGHT`를 만지면 여기가 먼저 움직인다" },
    { metric: "카드 기대 대비 배율 (구간)", role: "guard", min: 1, max: 1.1, why: "같은 기대치 · 같은 두 줄 규칙 — 두 시뮬이 같은 자리에 서야 한다" },
    { metric: "카드 — 간이/구간", role: "guard", min: 0.96, max: 1.04, unit: "ratio", why: "**두 시뮬이 한 눈금에 서는가 — 가장 날카로운 지표.** 강도를 한쪽만 곱하면 여기가 1/강도로 벌어진다 — 압박 5 팀에서 15%다. 표본이 팔당 45,000장이라 잡음은 1% 아래다" },
    { metric: "유리몸 팀 배율", role: "guard", min: 1.3, why: "선발 전원 성향 2.2일 때 건강한 팀 대비 — 성향이 빈도에 닿는지" },
    { metric: "유리몸 한 명의 부상 점유율", role: "guard", min: 0.08, unit: "ratio", why: "뛴 선수(선발 11 + 교체 최대 5) 중 한 명이면 균등은 6~7% — 성향 2.2가 그 위로 띄운다" },
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
    { metric: "개막 감각 — 친선 3경기 이상", role: "guard", min: 60, unit: "score", why: "프리시즌을 다 치른 몸은 개막에 `올라옴`(60) 위여야 한다 — 그 아래면 친선 넷으로도 판을 못 맞춘다는 뜻이다 (player.md §5.4)" },
    { metric: "개막 감각 — 친선 0경기", role: "measure", unit: "score", why: "한 경기도 안 뛴 몸이 어디에 서는가 — 훈련장의 천장(55) 부근이어야 정상이다" },
    { metric: "개막 감각 차 (친선 3+ vs 0)", role: "guard", min: 10, unit: "score", why: "이 값이 0이면 프리시즌이 몸에 관해 아무것도 결정하지 않는 것이다 — 이 축이 존재하는 이유 자체의 단일 지표 (#539)" },
    { metric: "개막 감각을 잰 인원", role: "measure", unit: "count", why: "두 무리가 비어 있으면 위 두 값이 뜻을 잃는다" },
    { metric: "시즌 말 감각 (상위 14명)", role: "guard", min: 70, unit: "score", why: "시즌을 돈 주전은 개막보다 날카로워야 한다 — 아래로 새면 감쇠가 적립을 이기고 있다" },
    { metric: "우리와 상대의 감각 격차", role: "guard", max: 10, unit: "score", why: "체력 격차와 같은 이유 — 이 축이 감독 팀에만 걸리면 리그 절반이 다른 규칙으로 무뎌진다" },
  ],
});

export const AI_BENCH = defineHarness({
  id: "ai-bench",
  what: "감독의 경기에서 상대 벤치가 쓰는 교체 수·시점·갈래",
  doc: "docs/simulation/match.md §2",
  cost: "시드당 수십 초 × 2시드",
  // prettier-ignore
  bands: [
    { metric: "AI 교체/경기", role: "guard", min: 3.5, max: 5, unit: "count", why: "실제 1부는 5인 교체제에서 4.3 — 정지점을 창으로 세는 정책(SUB_WINDOW_MAX·SUB_CHANCE·SUB_FATIGUE)이 그 부근에 세운다. 한도(5)는 장부가 막는다" },
    { metric: "승부수 교체/경기", role: "measure", unit: "count", why: "스코어를 읽은 갈래가 실제로 얼마나 쓰이는가" },
    { metric: "굳히기 교체/경기", role: "measure", unit: "count", why: "리드를 지키는 갈래 — 승부수보다 드물어야 정상이다" },
    { metric: "체력 교체/경기", role: "measure", unit: "count", why: "예전부터 있던 갈래 — 스코어 갈래가 이걸 밀어내지 않았는지" },
    { metric: "부상 교체/경기", role: "measure", unit: "count", why: "INJURY_PER_MATCH의 파생 — 다치면 언제나 뺀다" },
    { metric: "끝까지 뒤진 경기에서 승부수를 던진 비율", role: "guard", min: 0.5, unit: "ratio", why: "0이면 이 기능이 죽은 것이다 — 벤치가 스코어를 읽는가의 단일 지표" },
    { metric: "끝까지 앞선 경기에서 굳힌 비율", role: "measure", unit: "ratio", why: "굳히기는 75′이고 교체 카드를 먼저 쓴 팀은 못 쓴다" },
    { metric: "AI 교체의 60′ 이후 비율", role: "reference", min: 0.5, max: 0.95, unit: "ratio", why: "실제 교체는 후반에 몰린다 — 전부 후반이면 하프타임 갈래가 죽은 것이다" },
    { metric: "AI 교체 중앙 분", role: "measure", unit: "score", why: "실제 1부는 60분대 — 우리는 정지점(골·조용한 25분)이 후반에 몰려 그보다 뒤다" },
    { metric: "판의 모양을 바꾼 경기 비율", role: "measure", unit: "ratio", why: "경기당 한 번 — 스코어가 벌어진 경기에서만 선다" },
    { metric: "잰 경기 수", role: "measure", unit: "count", why: "표본이 있는가" },
  ],
});

export const AI_MARKET = defineHarness({
  id: "ai-market",
  what: "한 시즌의 AI↔AI 시장 규모, 그리고 우리 선수에게 선 관심이 오퍼가 되는 비율",
  doc: "docs/simulation/transfer.md §6 · §1-2",
  cost: "전체 세계 한 시즌 · 수 분",
  // prettier-ignore
  bands: [
    { metric: "총 이동", role: "measure", unit: "count", why: "이적 + 임대 — 팀당 값의 분모가 아니라 규모 그 자체" },
    { metric: "1부 팀당 이적", role: "guard", min: 1, max: 6, why: "실제 시장과 같은 자릿수" },
    { metric: "1부 팀당 임대", role: "guard", min: 0.5, max: 4, why: "실제 시장과 같은 자릿수" },
    { metric: "여름 비중", role: "guard", min: 0.5, unit: "ratio", why: "실제 시장의 여름:겨울은 7:3" },
    { metric: "우리 선수 관심", role: "guard", min: 5, max: 45, unit: "count", why: "한 시즌 우리 스쿼드에 선 관심 줄 수 — 라커룸이 매주 흔들리지 않으면서 창마다 이야기가 있는 폭 (transfer.md §1-2)" },
    { metric: "문의까지 오른 비중", role: "guard", min: 0.15, unit: "ratio", why: "밖에 나지 않는 관심만 쌓이면 사다리가 장식이다" },
    { metric: "오퍼가 된 비중", role: "guard", min: 0.05, max: 0.6, unit: "ratio", why: "관심이 전부 오퍼가 되면 사다리가 지연일 뿐이고, 하나도 안 되면 오퍼가 마른다" },
    { metric: "우리에게 온 오퍼", role: "measure", unit: "count", why: "우리에게 도착한 매각 오퍼 전부 — 관심 갈래와 이적 요청 갈래(§1-1)가 함께 든다" },
  ],
});

export const INCOMING_OFFERS = defineHarness({
  id: "incoming-offers",
  what: "한 시즌 우리 선수에게 온 매각 오퍼 — 수 · 마감 주 비중 · 큰 무대 비중 · 시장가 대비 값",
  doc: "docs/simulation/transfer.md §1-3",
  cost: "전체 세계 한 시즌 · 수 분",
  // prettier-ignore
  bands: [
    { metric: "우리에게 온 오퍼", role: "guard", min: 10, max: 45, unit: "count", why: "실제 1부 중위권은 여름 창 하나에 진지한 오퍼가 서너 건~열몇 건, 겨울까지 합쳐 그 두 배다. 하한은 「시장이 죽었다」, 상한은 「감독실이 오퍼로 덮인다」" },
    { metric: "마감 주 비중", role: "guard", min: 0.15, unit: "ratio", why: "창은 한 시즌 95일 안팎이고 마감 주는 그중 14일이라 균등이면 15% — `DEADLINE_RUSH`가 걸린 자리는 그보다 위여야 한다 (§1-3)" },
    { metric: "큰 무대 비중", role: "guard", min: 0.08, unit: "ratio", why: "우리보다 큰 무대(`gapTo > 0`)에서 오는 몫. 0에 가까우면 무대 무게(`suitorWeightOf`)가 죽어 2부 상위와 맨시티가 같은 확률로 부르는 자리로 돌아간 것이다" },
    { metric: "값/시장가 · 중앙값", role: "measure", why: "첫 호가는 흥정 여지를 남겨 시장가의 75~100%로 들어오고(§1-2), 요청 갈래는 그 아래다 — 아래 마감 주 값과 견줘 읽는다" },
    { metric: "마감 주 값/시장가 · 중앙값", role: "guard", min: 0.95, why: "마감 주에는 부르는 값과 사는 쪽 상한이 함께 `DEADLINE_PREMIUM`을 탄다 (§1-3). 배수가 값에 닿지 않으면 이 값은 위 「값/시장가」(0.75 언저리)로 내려앉으므로 그 사이에 문턱을 둔다 — 1.0에 붙이면 표본이 예닐곱뿐인 중앙값이 한 건에 흔들려 주간 워크플로가 매주 시끄럽다" },
    { metric: "주전 오퍼의 큰 무대 비중", role: "measure", unit: "ratio", why: "주전에게 붙는 끌림(`STAGE_PULL_STARTER`)이 실제로 위를 향하는가 — 위 「큰 무대 비중」보다 높아야 잉여와 갈린 것이다" },
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
  what: "15시즌을 넘긴 뒤에도 구단이 선발 XI·계약을 세우는가 · 리그 체급의 드리프트",
  doc: "docs/simulation/season.md §6·§9",
  cost: "세계 하나 · 월간 성장 180번 + 전환 15번 · 약 30초",
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
    { metric: "리그 1군 상위 15 종합 — 시작", role: "measure", unit: "score", why: "체급의 출발선 — 아래 두 줄을 읽을 자 (`overall-scale`이 이 분포의 원본을 잰다)" },
    { metric: "리그 1군 상위 15 종합 — 15시즌 뒤", role: "measure", unit: "score", why: "같은 자로 잰 도착선" },
    { metric: "시즌당 종합 드리프트", role: "measure", unit: "score", why: "성장과 노화의 수지 — 한 시즌에 리그 체급이 얼마나 움직이는가" },
    { metric: "리그 1군 상위 15 잠재력 — 시작", role: "measure", unit: "score", why: "체급의 천장 — 종합과 함께 읽어야 드리프트의 원인이 갈린다" },
    { metric: "리그 1군 상위 15 잠재력 — 15시즌 뒤", role: "measure", unit: "score", why: "같은 자로 잰 도착선" },
    { metric: "시즌당 잠재력 드리프트", role: "measure", unit: "score", why: "천장 자체가 움직였는가 — 종합만 내려가면 성장이 못 닿은 것이고, 함께 내려가면 여름마다 세계가 건네는 사람이 얇아진 것이다" },
  ],
});

/**
 * 유스 육성 — **2군 리그가 돌고, 감독의 선택이 유망주의 성장 속도를 가르는가**
 * (`docs/simulation/season.md` §2 2군 리그).
 */
export const YOUTH_DEVELOPMENT = defineHarness({
  id: "youth-development",
  what: "2군 경기 수 · 출전·집중 육성·임대가 가르는 성장 격차",
  doc: "docs/simulation/season.md §2",
  cost: "세계 하나 · 한 시즌 완주 · 수 분",
  // prettier-ignore
  bands: [
    { metric: "2군 경기 수", role: "guard", min: 15, max: 23, unit: "count", why: "리그 상대 싱글 라운드로빈(20팀이면 19경기)이 실제로 편성돼 돈다" },
    { metric: "결과 없는 2군 경기", role: "guard", max: 0, unit: "count", why: "시즌 종료 판정은 2군 리그를 기다리지 않는다 — 일정이 늦으면 조용히 안 치러진 채 남는다" },
    { metric: "2군 평균 출전", role: "guard", min: 5, unit: "count", why: "출전이 쌓여야 '2군 선수의 시즌 기록에 경기가 쌓인다'가 성립한다" },
    { metric: "집중 육성 시즌 성장", role: "reference", min: 2.5, max: 6, unit: "score", why: "집중 육성 + 2군 출전을 다 받은 유망주의 종합 상승 — 실제 원더키드의 해마다 +3~5 (`AXIS_GROWTH_PER_SEASON` × 배율)" },
    { metric: "무지정 우리 2군 U21 성장", role: "measure", unit: "score", why: "출전 배율만 받은 유망주 — 손잡이 하나의 몫을 가른다" },
    { metric: "타 팀 2군 U21 성장", role: "reference", min: 1.2, max: 3.5, unit: "score", why: "배율이 없는 기준선 — 코어 월간 성장 그대로. 실제 U21의 해마다 +2 안팎, 여유가 작은 선수가 섞여 평균은 그 아래다" },
    { metric: "집중 육성 격차", role: "reference", min: 0.5, unit: "score", why: "집중 육성 − 타 팀 기준선. 0이면 손잡이가 아무것도 가르지 않은 것이다" },
    { metric: "임대 표본", role: "guard", min: 2, unit: "count", why: "같은 리그로 보내 시즌 끝까지 임대로 남은 U21 — 표본이 줄면 아래 세 줄이 격차가 아니라 잡음이다" },
    { metric: "임대 U21 성장", role: "measure", unit: "score", why: "임대처 1군 출전 × 수준 계수만 받은 유망주의 종합 상승 (season.md §2 임대)" },
    { metric: "임대처 평균 출전", role: "guard", min: 2, max: 25, unit: "count", why: "그 구단 1군 경기를 실제로 몇 번 뛰었나 — **성장 배율에 곱할 분(分)이 있는가.** 빌린 구단이 임대 자원에게 치르는 값(로테이션 우선권 · 연속 미출전 상한 `LOAN_REST_LIMIT`)이 닫히면 이 줄이 0 언저리로 내려간다(문이 없던 시절 0.20이었다). 표본이 다섯이고 그중 기량 창 밖으로 나간 아이는 0이라, 하한은 '문이 닫혔다'와 '한둘이 자리를 못 얻었다'를 가르는 자리에 둔다. 상한 25는 그 반대편 — 아카데미 유망주가 1부 클럽의 주전이 되면 그건 임대가 아니라 이적이고 AI 순위표가 임대로 흔들린다" },
    { metric: "경보 전에 뛴 임대", role: "guard", min: 0.4, unit: "ratio", why: "그 구단 경기에서 **가장 긴 연속 미출전**이 `LOAN_BENCH_RUN_ALERT`(4) 미만인 임대의 몫 — 리콜 근거 `no-minutes`가 배경음인지 사건인지를 가른다. 연속 미출전 상한(`LOAN_REST_LIMIT` 3)이 경보 문턱보다 한 칸 앞이므로, 자리를 얻은 임대는 경보가 켜지기 전에 뛴다. **1.0을 요구하지 않는다**: 기량 창(`LOAN_ROTATION_OVR_DROP`) 밖으로 보낸 유망주는 한 경기도 못 뛰어야 하고, 그때 켜지는 경보가 곧 리콜 판단이다 — 다섯 중 둘이 하한이다" },
    { metric: "임대 격차", role: "reference", unit: "score", why: "임대 − 타 팀 기준선. ⚠️ **밴드를 두지 않는다 — 눈금 아래의 값이다.** 한 시즌 U21의 종합 상승이 0.2인데 임대 배율이 1.2~1.3이라 격차의 참값은 0.05 안쪽이고, 종합은 정수라 한 사람의 잡음이 0.45다(표본 다섯이면 부호가 동전이다). 배율 자체가 사는지는 `growth-curve` 단위 테스트가 같은 시드·같은 난수열에서 지키고, **세계가 그 배율에 곱할 분을 주는가**는 위의 `임대처 평균 출전`이 지킨다" },
    { metric: "성실한 U21 표본", role: "guard", min: 20, unit: "count", why: "아래 줄의 분모 — 배율 없는 타 팀 2군 U21 중 `professionalism` ≥ 1.1. 표본이 줄면 격차가 아니라 잡음이다" },
    { metric: "게으른 U21 표본", role: "guard", min: 20, unit: "count", why: "같은 줄의 반대쪽 — `professionalism` ≤ 0.95" },
    { metric: "직업의식 격차", role: "reference", min: 0, unit: "score", why: "성실 − 게으름. 배율이 없는 표본이라 남는 차이는 원형뿐이다 — 0 이하면 계수가 세계에 닿지 않았다 (people.md §6)" },
  ],
});

/**
 * 2군 강등이 낳는 불만 — **문턱이 로테이션과 방치를 가르는가** (`docs/data/people.md` §5).
 *
 * 상수 하나(21일)가 두 가지 플레이를 동시에 정한다: 짧으면 선수를 잠깐 내렸다
 * 올리는 로테이션이 곧 반란이 되고, 길면 강등이 지금처럼 **비용 0인 손잡이**로
 * 남는다. 어느 쪽인지는 한 시즌을 굴려 봐야 보인다 — 코드를 읽어서는 알 수 없고,
 * 고정 기댓값이 있는 단위 테스트로도 잡히지 않는다.
 *
 * 문턱에 원형의 `patience`가 곱해진 뒤로(people.md §6) 날짜 자체는 사람마다 다르다 —
 * 그래서 밴드는 날짜가 아니라 **제 문턱을 넘고 밀린 날**을 쥔다.
 */
export const NEGOTIATION = defineHarness({
  id: "negotiation",
  what: "재계약·해지·영입의 성사 확률 분포 — 기대치를 맞춘 제안이 자동 통과인가",
  doc: "docs/simulation/transfer.md §3",
  cost: "세계 하나 · 수 초",
  // prettier-ignore
  bands: [
    { metric: "표본 · 재계약", role: "guard", min: 25, unit: "count", why: "우리 스쿼드 전원을 잰다 — 표본이 줄면 분포가 아니다" },
    { metric: "재계약 기대치 · 중앙값", role: "measure", unit: "score", why: "기대 주급 100% · 3년 제안의 성사 확률" },
    { metric: "재계약 기대치 · p90−p10", role: "guard", min: 20, unit: "score", why: "조건에 따라 실제로 갈리는가 — 폭이 없으면 축이 죽어 있다. 표본이 한 구단의 첫날(같은 대항전·불만 없음)이라 폭의 바닥은 낮게 둔다" },
    { metric: "재계약 기대치 · 90% 이상 비율", role: "guard", max: 0.3, unit: "ratio", why: "기대치를 맞춘 제안이 자동 통과가 아니다" },
    { metric: "재계약 기대치 · 앵커가 조정인 비율", role: "measure", unit: "ratio", why: "`COUNTERPARTY_COUNTER_AT`~`COUNTERPARTY_ACCEPT_AT` 구간 — 사다리의 가운데 칸에 서는 몫" },
    { metric: "재계약 70% 주급 · 중앙값", role: "reference", max: 50, unit: "score", why: "기대치의 70%는 반 이상 실패해야 한다" },
    { metric: "해지 기대치 · 중앙값", role: "measure", unit: "score", why: "기대 정산금 일시금 제안의 성사 확률" },
    { metric: "해지 기대치 · p90−p10", role: "measure", unit: "score", why: "잔여 계약·나이·갈 곳이 해지를 실제로 가르는가" },
    { metric: "표본 · 영입", role: "guard", min: 40, unit: "count", why: "타 구단 66~84 표본 — 표본이 줄면 분포가 아니다" },
    { metric: "영입 기대치 · 중앙값", role: "measure", unit: "score", why: "호가·희망 주급을 그대로 맞춘 4년 오퍼의 성사 확률" },
    { metric: "영입 기대치 · p90−p10", role: "guard", min: 20, unit: "score", why: "선수 관문이 구단 관문 뒤에 숨은 도장이 아니다" },
    { metric: "영입 기대치 · 90% 이상 비율", role: "guard", max: 0.2, unit: "ratio", why: "호가를 맞췄다고 선수까지 자동으로 오지 않는다" },
    { metric: "영입 · 원형별 중앙값 폭", role: "guard", min: 5, max: 35, unit: "score", why: "대리인의 `askingLift`가 확률에 실제로 걸리는가 — **중립 오퍼**(원형을 걷어 낸 값)를 원형별로 잰 중앙값의 최대−최소. 감독이 실제로 겪는 폭이 아니다: `suggest_terms`가 이미 원형이 얹힌 값을 부르므로 그 자리의 확률은 원형과 무관하다. 0이면 원형이 죽었고, 너무 넓으면 같은 돈이 대리인 추첨이 된다 (transfer.md §3)" },
    { metric: "영입 · 승부사형 중앙값", role: "measure", unit: "score", why: "값을 가장 높이 부르는 원형 — 중립 오퍼가 가장 안 통하는 자리다" },
    { metric: "영입 · 제국형 중앙값", role: "measure", unit: "score", why: "배수가 1인 원형 — 「영입 기대치 · 중앙값」 근처에 서야 셈이 맞는다" },
    { metric: "영입 · 법률가형 중앙값", role: "measure", unit: "score", why: "값을 가장 낮게 부르는 원형 — 같은 오퍼가 가장 잘 통한다" },
  ],
});

export const DEMOTION_GRIEVANCE = defineHarness({
  id: "demotion-grievance",
  what: "한 시즌 2군 강등이 낳는 불만 — 로테이션은 공짜고 방치는 값을 치르는가",
  doc: "docs/data/people.md §5",
  cost: "축소 세계 한 시즌 · 약 10초",
  // prettier-ignore
  bands: [
    { metric: "로테이션 강등 횟수", role: "measure", unit: "count", why: "아래 두 줄의 표본 — 0이면 로테이션을 재지 못한 것이다" },
    { metric: "로테이션 복귀 실패", role: "guard", max: 0, unit: "count", why: "올리지 못한 선수는 방치와 구분되지 않는다 — 실패가 있으면 아래 줄이 로테이션을 재는 것이 아니다" },
    { metric: "로테이션 자원에 걸린 불만", role: "guard", max: 0, unit: "count", why: "열흘 안에 되돌리는 감독은 대가를 치르지 않는다 — 여기가 1이면 로테이션이 곧 반란이다" },
    { metric: "방치한 핵심 자원", role: "guard", min: 3, max: 3, unit: "count", why: "아래 줄의 분모 — 스쿼드 하한에 걸려 덜 내려갔으면 밴드가 공허하다" },
    { metric: "방치 끝에 불만이 걸린 수", role: "guard", min: 3, max: 3, unit: "count", why: "한 시즌을 그대로 두고도 조용하면 강등은 여전히 비용 0인 손잡이다" },
    { metric: "첫 방치 불만까지 걸린 날", role: "measure", unit: "count", why: "가장 먼저 문을 두드린 사람이 며칠을 참았나 — 문턱이 사람마다 다르므로(people.md §6) 밴드는 아래 두 줄이 쥔다" },
    { metric: "방치 자원의 문턱 폭", role: "reference", min: 1, unit: "count", why: "방치한 셋의 문턱 최대−최소. 0이면 셋이 같은 원형이거나 계수가 닿지 않은 것이다" },
    { metric: "제 문턱을 넘고 밀린 날", role: "guard", min: 0, max: 6, unit: "count", why: "**그 사람의** 문턱을 넘은 뒤 실제로 걸리기까지. 판정이 주에 한 번이라 최대 엿새이고, 음수면 문턱을 안 지키고 걸린 것이다" },
    { metric: "시즌 강등발 불만 건수", role: "measure", unit: "count", why: "감독 하나가 한 시즌에 몇 번 이 자리를 만나는가" },
    { metric: "시즌 출전 불만 건수", role: "measure", unit: "count", why: "지위 대비 출전이 낳는 불만 (people.md §5). 강등 밴드의 분모를 흔드는 것이 이 줄이다 — 먼저 걸린 `minutes` 불만은 같은 선수의 `demotion` 불만을 막는다" },
    { metric: "시즌 약속 파기 건수", role: "measure", unit: "count", why: "아무 약속도 하지 않는 감독에게는 0이어야 한다 (people.md §5-2)" },
  ],
});

/**
 * 다가옴의 건수 — **세계가 얼마나 자주 먼저 말을 거는가** (`docs/data/people.md` §8).
 *
 * 임계·증가량은 코드를 읽어서는 정할 수 없는 값이다. 낮으면 감독이 매주 감독실 문을
 * 열어 주다 지치고, 높으면 "세계는 감독 없이도 움직인다"가 사기 숫자로만 남는다.
 * 한 시즌을 **아무것도 하지 않는 감독**으로 굴려 건수와 채널 분포를 잰다 — 방치의
 * 상한이 곧 이 기능의 소음 상한이다.
 */
export const APPROACH_RATE = defineHarness({
  id: "approach-rate",
  what: "한 시즌 다가옴 건수 · 채널 분포 · 소음의 문이 실제로 서는가",
  doc: "docs/data/people.md §8",
  cost: "축소 세계 한 시즌 · 약 10초",
  // prettier-ignore
  bands: [
    { metric: "시즌 다가옴 건수", role: "guard", min: 3, max: 36, unit: "count", why: "**방치만 하는 감독의 상한**이다. 아래끝은 세계가 조용한 것이고, 위끝은 열흘에 한 번 — 그보다 잦으면 답하는 감독에게도 소음이 된다" },
    { metric: "선수 채널", role: "measure", unit: "count", why: "자기 일로 온 사람 — 불만 수를 따라간다" },
    { metric: "에이전트 채널", role: "measure", unit: "count", why: "대리인이 온 자리 — 계약 만료·타 구단 관심·이적 요청" },
    { metric: "주장 채널", role: "measure", unit: "count", why: "라커룸이 식은 구간이 있었는가" },
    { metric: "구단주 채널", role: "measure", unit: "count", why: "순위가 기대 아래에 머문 구간 — 보드 요청" },
    { metric: "출전 기회(minutes)", role: "measure", unit: "count", why: "지위 대비 출전으로 결정적으로 서는 불만이 몇 번 감독실 문을 두드리는가 (people.md §5) — 주사위를 걷은 뒤 이 줄이 위 합계를 밀어 올리는지가 재는 것이다" },
    { metric: "어긴 약속(promise)", role: "measure", unit: "count", why: "아무 약속도 하지 않는 감독에게는 0이어야 한다 — 0이 아니면 약속을 하지 않은 자리에서 장부가 약속을 세운 것이다" },
    { metric: "등번호(number)", role: "measure", unit: "count", why: "번호를 한 번도 옮기지 않는 감독에게는 0이어야 한다 (people.md §5) — 0이 아니면 감독이 손대지 않은 자리에서 장부가 번호를 옮긴 것이다. 원형별 무게 자체는 여기서 재지 않는다: 문턱이 결정적이라 분포가 없고, 경계는 `numberGrievanceStands` 단위 테스트가 지킨다" },
    { metric: "계약 만료(contract)", role: "measure", unit: "count", why: "재계약을 한 번도 열지 않은 감독에게 에이전트가 몇 번 오는가" },
    { metric: "타 구단 관심(interest)", role: "measure", unit: "count", why: "오퍼를 그냥 흘려보낸 뒤 대리인이 오는 빈도 — 창 14일 안에 임계를 넘어야 선다" },
    { metric: "언론 유출(계단 4)", role: "guard", max: 8, unit: "count", why: "방치만 하는 감독의 상한. 자리가 아니라 사건이라 답할 곳이 없고 값은 다음 회견이 치른다 — 그보다 잦으면 회견이 유출 카드로만 채워진다" },
    { metric: "이적 요청(계단 5)", role: "guard", max: 7, unit: "count", why: "사다리 끝까지 방치된 불만의 수. 한 시즌 스쿼드의 한 줌을 넘으면 방치의 대가가 아니라 스쿼드 붕괴다 — 사유가 넷에서 여덟이 되며(people.md §5) 끝까지 갈 수 있는 갈래도 두 배가 됐고, 43명 스쿼드에서 일곱은 여전히 한 줌이다" },
    { metric: "이적 요청(장부)", role: "guard", max: 10, unit: "count", why: "사유 셋이 함께 세운 요청의 총합 (transfer.md §1-1). 사다리에서 오는 것만 세는 위 줄과 달리 시장이 세우는 둘까지 든다 — 43명 스쿼드에서 한 시즌 열 건이면 이미 스쿼드의 한 줌이고, 그보다 잦으면 감독이 답하는 것이 아니라 매일 답하게 된다" },
    { metric: "요청 사유 grievance", role: "measure", unit: "count", why: "사다리에서 온 것 — 위의 계단 5 줄과 같은 사건을 장부 쪽에서 센다. 둘이 어긋나면 계단 5가 장부에 안 적혔거나 요청이 걷힌 뒤 다시 섰다는 뜻이다" },
    { metric: "요청 사유 blocked-move", role: "measure", unit: "count", why: "값이 붙은 오퍼를 같은 창에서 두 번 막은 수 — 아무 오퍼도 판정하지 않는 감독에게는 0이어야 한다" },
    { metric: "요청 사유 bigger-club", role: "measure", unit: "count", why: "`BIGGER_CLUB_CHANCE`가 창이 열린 날마다 굴린 결과. 축소 세계의 감독 팀은 그 세계에서 가장 큰 구단이라 「우리보다 큰 구애자」가 서지 않아 **0이 정상**이다 — 0이 아니면 조건이나 전력 눈금이 움직인 것이고, 그때 재는 값은 이 줄이 아니라 시즌당 몇 건인가다" },
    { metric: "하루 두 건이 열린 날", role: "guard", max: 0, unit: "count", why: "하루 한 건의 문 (people.md §8)" },
    { metric: "동시에 열린 자리", role: "guard", max: 0, unit: "count", why: "열려 있는 다가옴은 하나뿐" },
    { metric: "같은 화자 7일 내 재개", role: "guard", max: 0, unit: "count", why: "같은 화자 쿨다운" },
    { metric: "갓 열린 회견과 겹친 자리", role: "guard", max: 0, unit: "count", why: "한 번에 답을 요구하는 자리는 하나다 — 사흘 지난 회견은 세지 않는다" },
    { metric: "가장 높이 오른 계단", role: "measure", unit: "count", why: "방치만 하는 감독이 사다리 끝까지 가는가 — 선수 주제는 5, 주장·구단주는 3이 꼭대기다" },
    { metric: "첫 자리까지 걸린 날", role: "measure", unit: "count", why: "임계 100을 채우는 데 걸린 실제 날 수" },
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

/**
 * 자체 산정 모델(`world/synthesis.ts`)이 낸 분포와 **지금 시드 분포의 간격**.
 *
 * 밴드가 절대값이 아니라 차에 걸리는 이유는 시드가 갱신되기 때문이다 — "합성 평균이
 * 72~74"는 시드가 움직이는 순간 낡지만 "합성과 시드의 차가 ±2"는 그대로 묻는다.
 * 폭은 실제로 재서 정했다: 종합 눈금은 ±1점 안에 앉으므로 ±2가 어긋남의 신호이고,
 * 자리·나이처럼 표본이 얇거나 표집이 흔들리는 값은 그보다 넓다.
 */
export const ATTRIBUTE_MODEL = defineHarness({
  id: "attribute-model",
  what: "자체 산정 모델이 낸 분포와 지금 시드 분포의 간격 — 체급·낙차·자리·나이·잠재력",
  doc: "docs/data/player.md §13",
  cost: "세계를 세우지 않는다 — 시드 2,800명을 재고 같은 수를 합성한다, 수 초",
  // prettier-ignore
  bands: [
    { metric: "팀 수", role: "measure", unit: "count", why: "시드를 가진 클럽 — 합성 쪽도 같은 구성이다" },
    { metric: "선수 수", role: "measure", unit: "count", why: "같은 스쿼드 크기로 세우므로 두 쪽이 같다" },
    { metric: "종합 평균 차", role: "guard", min: -2, max: 2, why: "세계의 눈금 그 자체 — 여기가 벌어지면 시장가·주급·등급 색이 통째로 따라 움직인다" },
    { metric: "종합 p10 차", role: "reference", min: -3, max: 3, why: "아카데미 쪽 꼬리. 낙차 표의 끝 구간이 정한다" },
    { metric: "종합 p50 차", role: "guard", min: -2, max: 2, why: "평균과 함께 봐야 한쪽이 꼬리로 끌린 것인지 알 수 있다" },
    { metric: "종합 p90 차", role: "reference", min: -3, max: 3, why: "주전 상위. 꼭대기와 낙차의 앞 구간이 정한다" },
    { metric: "체급1 종합 p50 차", role: "reference", min: -3, max: 3, why: "체급이 스쿼드 전체를 옮기는지 — 넷을 함께 본다" },
    { metric: "체급2 종합 p50 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "체급3 종합 p50 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "체급4 종합 p50 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "체급1 꼭대기 평균 차", role: "reference", min: -2, max: 2, why: "`SQUAD_APEX`가 실제로 그 값을 내는가 — 모델의 ①이 서는 자리" },
    { metric: "체급2 꼭대기 평균 차", role: "reference", min: -2, max: 2, why: "" },
    { metric: "체급3 꼭대기 평균 차", role: "reference", min: -2, max: 2, why: "" },
    { metric: "체급4 꼭대기 평균 차", role: "reference", min: -2, max: 2, why: "표본이 22팀뿐이라 위 셋보다 흔들린다" },
    { metric: "낙차 순번0~4 차", role: "reference", min: -1.5, max: 1.5, why: "주전 구간 — 여기가 벌어지면 선발 XI의 폭이 달라진다" },
    { metric: "낙차 순번5~10 차", role: "reference", min: -1.5, max: 1.5, why: "로테이션 구간" },
    { metric: "낙차 순번11~17 차", role: "reference", min: -1.5, max: 1.5, why: "" },
    { metric: "낙차 순번18~24 차", role: "reference", min: -2, max: 2, why: "" },
    { metric: "낙차 순번25+ 차", role: "reference", min: -3, max: 3, why: "아카데미 구간 — 표 끝 너머를 기울기로 잇는 자리라 가장 넓다" },
    { metric: "자리 GK 평균 차", role: "reference", min: -3, max: 3, why: "자리별 평균 — 한 자리만 어긋나면 그 자리 선수만 다른 세계에 산다" },
    { metric: "자리 CB 평균 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "자리 FB 평균 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "자리 DM 평균 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "자리 CM 평균 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "자리 AM 평균 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "자리 W 평균 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "자리 CF 평균 차", role: "reference", min: -3, max: 3, why: "표본 83명 — 위보다 흔들린다" },
    { metric: "자리 ST 평균 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "나이 평균 차", role: "reference", min: -1.5, max: 1.5, why: "나이는 종합이 아니라 잠재력 여유와 침착성·리더십을 정한다 (player.md §13.2)" },
    { metric: "나이 p10 차", role: "reference", min: -2, max: 2, why: "어린 쪽 꼬리 — 유스 유입과 이어지는 자리" },
    { metric: "나이 p90 차", role: "reference", min: -2, max: 2, why: "늙은 쪽 꼬리 — 재계약·은퇴가 읽는 자리" },
    { metric: "잠재력 여유 평균 차", role: "reference", min: -2, max: 2, why: "여유가 곧 성장 여지다 — 벌어지면 세계가 통째로 자라거나 멎는다" },
    { metric: "잠재력 여유 p90 차", role: "reference", min: -4, max: 4, why: "유망주 쪽 꼬리. 99 천장에 잘리는 자리라 평균보다 넓다" },
    { metric: "잠재력 대역 상한 초과 비율", role: "guard", max: 0, unit: "ratio", why: "player.md §6.5 나이별 상한 — 넘긴 선수는 영영 닿지 않는 천장을 갖는다" },
    { metric: "되맞춤 평균 반복", role: "measure", why: "상한은 `RETARGET_MAX_PASSES` — 평균이 거기 붙으면 되먹임이 수렴하지 않는 것이다" },
    { metric: "되맞춤 목표 미달 비율", role: "guard", max: 0.02, unit: "ratio", why: "목표에서 벗어난 몫 — 이 값이 크면 ①②가 정한 눈금을 모델이 안 지키는 것이다" },
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

export const PROMPT_REGRESSION = defineHarness({
  id: "prompt-regression",
  what: "프롬프트 층의 글자·프리픽스 안정성 · 모의 세션의 장면 문법과 스킬 적중률",
  doc: PROMPTS,
  cost: "세계 둘 + 모의 GM 세션 — 수 초",
  // prettier-ignore
  bands: [
    { metric: "고정층 글자", role: "guard", max: 30500, unit: "count", why: "매 턴 캐시 프리픽스로 나가는 하한 — 프롬프트는 지우는 방향으로 고친다 (prompts.md §5). 여백은 거의 없다: 문구가 늘면 잡히고, 도구가 늘어 넘겼으면 그때만 다시 자른다" },
    { metric: "시스템 프롬프트 글자", role: "reference", min: 1500, max: 3000, unit: "count", why: "도구와 무관하게 매 턴 서는 규칙만 — 도구 사용법이 새어 들어오면 늘어난다" },
    { metric: "도구 스펙 글자", role: "measure", unit: "count", why: "설명 + Zod에서 파생된 JSON 스키마 — 고정층의 대부분이다" },
    { metric: "도구 설명 총 글자", role: "measure", unit: "count", why: "상한은 skill-descriptions.test.ts가 쥔다 — 여기서는 그 안 어디쯤인지만 읽는다" },
    { metric: "가장 긴 도구 설명 글자", role: "measure", unit: "count", why: "한 도구가 설명 예산을 혼자 먹고 있는가" },
    { metric: "레퍼런스층 글자", role: "reference", max: 600, unit: "count", why: "구단 이름과 감독 프로필뿐이다(<club>·<manager>) — 선수 이름·수치가 들어오면 캐시가 그것과 함께 깨진다" },
    { metric: "매 턴 층 글자", role: "reference", max: 3000, unit: "count", why: "캐시가 걸리지 않는 유일한 층 — 매 턴 정가로 나간다" },
    { metric: "고정층 비중", role: "measure", unit: "ratio", why: "고정 ÷ (고정 + 레퍼런스 + 매 턴) — 캐시가 덮는 몫" },
    { metric: "고정층 프리픽스 안정성", role: "guard", min: 1, max: 1, unit: "ratio", why: "다른 세계 둘에서 바이트까지 같아야 한다 — 날짜·id가 한 글자 섞이면 매 턴 뒤가 전부 정가로 읽힌다 (models.md §4)" },
    { metric: "레퍼런스층 프리픽스 안정성", role: "guard", min: 1, max: 1, unit: "ratio", why: "같은 세이브라면 날짜가 흘러도 같아야 한다 — 여기가 바뀌면 이 층과 그 뒤 이력이 통째로 무효가 된다" },
    { metric: "장면 문법 준수율", role: "guard", min: 1, unit: "ratio", why: "시점 헤더 한 줄 + `@` 줄로 여는 본문 — 그 뒤의 태그 없는 줄은 이어쓰기다 (prompts.md §1)" },
    { metric: "위생이 걷어낸 줄 비율", role: "guard", max: 0, unit: "ratio", why: "모의 장면은 이미 문법 안이다 — 위생이 무엇이든 걷었다면 문법이나 위생 한쪽이 움직인 것이다" },
    { metric: "시점 헤더 파싱 성공률", role: "guard", min: 1, unit: "ratio", why: "헤더를 못 읽으면 그 턴의 시계가 멎는다 (prompts.md §1)" },
    { metric: "평균 장면 글자", role: "measure", unit: "count", why: "모의 GM의 장면 길이 — 실모드의 400~800 예산과는 다른 눈금이다" },
    { metric: "스킬 적중률", role: "guard", min: 1, unit: "ratio", why: "코퍼스가 겨냥한 스킬을 실제로 불렀는가 — 떨어지면 스킬 표면이나 모의 GM이 갈린 것이다 (agents.md §8)" },
    { metric: "불린 스킬 가짓수", role: "measure", unit: "count", why: "코퍼스가 훑는 표면의 폭" },
  ],
});

/**
 * `pnpm balance --list`가 읽는 목록.
 *
 * **`*.harness.ts`와 일대일이다** — 여기 없는 하네스는 돌면서도 리포트의 「몇 개가
 * 보고했다」 분모에서 빠지고, 여기만 있는 서술자는 목록에 서면서 돌지 않는다. 둘 다
 * 조용해서 오래 사니 `harness-catalog.test.ts`가 그 짝을 못 박는다.
 */
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
  AI_BENCH,
  AI_MARKET,
  INCOMING_OFFERS,
  MANAGER_MARKET,
  NEGOTIATION,
  SQUAD_LONGEVITY,
  YOUTH_DEVELOPMENT,
  DEMOTION_GRIEVANCE,
  APPROACH_RATE,
  OVERALL_SCALE,
  ATTRIBUTE_MODEL,
  HISTORY_WINDOW,
  PROMPT_REGRESSION,
];
