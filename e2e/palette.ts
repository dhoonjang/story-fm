import type { Page } from "@playwright/test";

/**
 * **색은 값이 아니라 토큰으로 잰다.**
 *
 * 스펙이 `rgb(194, 160, 94)`를 그대로 적으면 팔레트를 한 칸 손보는 순간 e2e가
 * 통째로 빨개진다 — 화면은 멀쩡한데. 지키려는 규칙은 "선호 포지션은 금색"이지
 * 그 금색의 값이 아니므로, 지금 `--gold-soft`가 무슨 색인지를 브라우저에 되묻고
 * 그것과 비교한다.
 *
 * 그래도 `getComputedStyle`을 계속 쓰는 이유: 같은 선택자가 파일 뒤쪽에 한 벌 더
 * 있어 앞에서 무엇을 고쳐도 조용히 덮이는 사고는 **클래스 이름으로는 잡히지
 * 않는다**. 값이 아니라 매핑을 재면 두 가지를 다 얻는다.
 */
export async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((varName) => {
    const declared = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    if (declared === "") throw new Error(`CSS 토큰 ${varName}이 :root에 없다`);
    const probe = document.createElement("span");
    probe.style.color = `var(${varName})`;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, name);
}
