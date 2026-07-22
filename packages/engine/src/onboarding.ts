import type { ManagerAttributes } from "@story-fm/domain";

/**
 * 온보딩 — 유저가 직접 입력한 배경(자유 텍스트)을 능력치 4축으로 배분한다
 * (결정 #11, attribute-model.md §7). 실모드에선 GM(LLM)이 판정하지만,
 * 그 결과도 이 규칙과 같은 제약(합계 고정·범위)을 통과해야 한다.
 * mock 모드·LLM 실패 폴백은 이 휴리스틱을 그대로 쓴다.
 */

export const ONBOARDING_TOTAL = 240; // 평균 60 × 4축
const MIN_AXIS = 40;
const MAX_AXIS = 78;

const KEYWORD_WEIGHTS: Array<{ pattern: RegExp; axis: keyof ManagerAttributes; bonus: number }> = [
  { pattern: /선수|주장|캡틴|수비수|공격수|미드필더|은퇴/u, axis: "leadership", bonus: 10 },
  { pattern: /선수|프로|리그에서/u, axis: "tactics", bonus: 4 },
  { pattern: /분석|데이터|코치|전술|스카우트|연구/u, axis: "tactics", bonus: 12 },
  { pattern: /에이전트|협상|비즈니스|영업|딜/u, axis: "negotiation", bonus: 12 },
  { pattern: /방송|해설|기자|미디어|유튜|인터뷰/u, axis: "media", bonus: 12 },
  { pattern: /감독|지도자|유소년/u, axis: "leadership", bonus: 6 },
];

const clampAxis = (x: number) => Math.max(MIN_AXIS, Math.min(MAX_AXIS, Math.round(x)));

/** 합계를 ONBOARDING_TOTAL로 정규화 — 축별 범위 안에서 */
export function normalizeAttributes(raw: ManagerAttributes): ManagerAttributes {
  const axes: Array<keyof ManagerAttributes> = ["leadership", "tactics", "negotiation", "media"];
  const clamped = Object.fromEntries(
    axes.map((a) => [a, clampAxis(raw[a])]),
  ) as ManagerAttributes;

  let diff = ONBOARDING_TOTAL - axes.reduce((s, a) => s + clamped[a], 0);
  // 남는/모자란 포인트를 큰 축부터(또는 작은 축부터) 1점씩 분배
  const order = [...axes].sort((a, b) =>
    diff > 0 ? clamped[b] - clamped[a] : clamped[a] - clamped[b],
  );
  let guard = 200;
  while (diff !== 0 && guard-- > 0) {
    for (const axis of order) {
      if (diff === 0) break;
      const next = clamped[axis] + Math.sign(diff);
      if (next >= MIN_AXIS && next <= MAX_AXIS) {
        clamped[axis] = next;
        diff -= Math.sign(diff);
      }
    }
  }
  return clamped;
}

export function interpretBackgroundHeuristic(background: string): ManagerAttributes {
  const base: ManagerAttributes = { leadership: 55, tactics: 55, negotiation: 55, media: 55 };
  for (const { pattern, axis, bonus } of KEYWORD_WEIGHTS) {
    if (pattern.test(background)) base[axis] += bonus;
  }
  return normalizeAttributes(base);
}
