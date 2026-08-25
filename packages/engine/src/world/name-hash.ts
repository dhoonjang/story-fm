/**
 * 이름 해시 — 시드 없이도 같은 선수는 항상 같은 파생값.
 *
 * 세계 생성(능력치 편차·주발·키·몸무게·포지션·홈그로운)이 전부 이 값을 읽으므로
 * **이 함수를 바꾸면 카탈로그가 통째로 달라진다.**
 *
 * ⚠️ `sim/rng.ts`의 `hashChannel`(엔진은 `core/rng.ts`로 재수출)은 같은 FNV-1a지만 `>>> 0`이라 **같은 입력에
 * 다른 값을 낸다.** 서로 대체할 수 없다 — 난수 채널 파생은 그쪽, 카탈로그 파생은
 * 이쪽이다.
 */
export function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
