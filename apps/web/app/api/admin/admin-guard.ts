import { NextResponse } from "next/server";

/**
 * 어드민 카탈로그 쓰기의 문 (game-state.md §2).
 *
 * 카탈로그 오버라이드는 **디스크에 쓰는 길**인데 어드민 라우트에는 로그인이 없다.
 * 배포된 인스턴스에서 열려 있으면 요청 하나로 세계의 초기치가 바뀌고
 * `catalog-reset`은 편집을 통째로 지운다. 그래서 쓰기 메서드는 이 문을 먼저
 * 지나고, 닫혀 있으면 본문 없는 404 — 없는 길이 된다.
 *
 * 조회는 막지 않는다. 카탈로그를 읽는 것으로는 아무것도 바뀌지 않는다.
 */

/** 문이 보는 것 — `process.env`의 두 칸 */
export interface AdminEnv {
  ADMIN_ENABLED?: string | undefined;
  NODE_ENV?: string | undefined;
}

/**
 * 어드민 쓰기가 열려 있는가 — **명시된 값이 먼저다.**
 *
 * `ADMIN_ENABLED`는 배포한 인스턴스에서 자기 카탈로그를 고치는 길(`1`)이자 개발
 * 서버에서 닫힌 동작을 확인하는 길(`0`)이고, `NODE_ENV`는 아무도 값을 주지 않았을
 * 때의 기본값이다. **빈 문자열은 값을 준 것이 아니다** — 셸이 비운 변수가 문을
 * 열어서는 안 된다.
 */
export function adminWritesEnabled(env: AdminEnv = process.env): boolean {
  const flag = env.ADMIN_ENABLED;
  if (flag !== undefined && flag !== "") {
    const on = flag.toLowerCase();
    return on === "1" || on === "true";
  }
  return env.NODE_ENV !== "production";
}

/**
 * 쓰기 핸들러를 감싼다 — `export const PATCH = adminWrite(async (…) => …)`.
 *
 * 라우트마다 첫 줄에 검사를 적는 방식이면 다음에 붙는 쓰기 핸들러가 그 줄을
 * 빠뜨려도 아무도 모른다. 감싸는 쪽은 빠뜨릴 자리가 없다.
 */
export function adminWrite<A extends unknown[]>(
  handler: (...args: A) => Response | Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    if (!adminWritesEnabled()) return new NextResponse(null, { status: 404 });
    return handler(...args);
  };
}
