/**
 * 출력 스키마로 받은 답을 읽는다 — **제공자 셋이 같은 자리다** (models.md §3-2).
 *
 * 셋 다 스키마에 맞춘 JSON을 본문 텍스트로 돌려준다. 어댑터는 여기까지고, 그 객체가
 * 스키마를 지키는지는 부르는 쪽의 Zod가 본다 — 제공자가 스키마를 얼마나 강제하는지가
 * 다르기 때문이다(OpenAI는 `strict: false`라 안내일 뿐이다).
 *
 * 최상위는 객체여야 한다(`JsonObjectSchema`). 잘린 응답의 반쪽 JSON, 거절 문장, 산문은 전부
 * `null`이다 — 그것이 "산출이 오지 않았다"의 유일한 신호다.
 */
export function parseOutput(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
