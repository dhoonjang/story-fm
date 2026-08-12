/** 새 보고서 객체와 숫자만 저장된 옛 보고서를 같은 숫자 표기로 읽는다. */
export function scoutValue(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value !== "object" || value === null) return null;
  const nested = (value as { value?: unknown }).value;
  return typeof nested === "number" ? nested : null;
}

export function scoutMargin(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  const margin = (value as { margin?: unknown }).margin;
  return typeof margin === "number" ? margin : 0;
}

/** 숫자의 강약만 은은하게 구분하는 네 구간. */
export function ratingTone(value: number): "top" | "strong" | "solid" | "low" {
  if (value >= 85) return "top";
  if (value >= 75) return "strong";
  if (value >= 65) return "solid";
  return "low";
}
