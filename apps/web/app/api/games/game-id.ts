import { NextResponse } from "next/server";
import { z } from "zod";

/**
 * 게임 id — **세이브 파일의 이름이 되는 값이다.**
 *
 * `loadGame`·`deleteGame`은 받은 id를 `path.join(dir, `${id}.json`)`으로 그대로
 * 잇고(`packages/engine/src/core/persistence.ts`), 원문 사이드카는 `${id}.trace`
 * 디렉터리를 통째로 지운다(`packages/llm/src/turn-trace.ts`). 경로 조각이 섞인
 * id는 데이터 디렉터리 밖을 가리키므로 **라우트가 디스크에 닿기 전에** 걸러야
 * 한다 — 파일 이름에 쓸 수 있는 글자만 통과시킨다.
 */
export const gameIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * `[id]` 라우트가 첫 줄에서 부르는 관문 — 통과하면 `null`, 아니면 그대로 돌려줄
 * 400이다. 없는 게임(404)과 구별한다: 열어 볼 수조차 없는 이름은 요청이 잘못된
 * 것이지 게임이 사라진 것이 아니다.
 */
export function invalidGameId(id: string): NextResponse | null {
  if (gameIdSchema.safeParse(id).success) return null;
  return NextResponse.json({ error: "게임 id가 올바르지 않습니다" }, { status: 400 });
}
