import { NextResponse } from "next/server";
import { z } from "zod";
import { loadGame, saveGame, type GameState } from "@story-fm/engine";
import { runGmTurn } from "@story-fm/agents";
import { toPayload } from "@/lib/store";

const TurnSchema = z.object({ message: z.string().min(1).max(1000) });

/**
 * 게임별 턴 직렬화 — 같은 게임의 동시 요청이 저장을 서로 덮어쓰지 않게
 * 프로세스 내 뮤텍스로 순차 처리한다 (리뷰 발견: 저장 경합).
 */
const locks = new Map<string, Promise<unknown>>();
function withGameLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    id,
    next.catch(() => undefined),
  );
  return next;
}

/** 유저 턴 → GM 실행 → 모델 턴 (ai-manager §2) */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }
  const body = TurnSchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json({ error: "메시지가 필요합니다" }, { status: 400 });
  }

  return withGameLock(id, async () => {
    const state = loadGame(id);
    if (!state) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });

    // 턴 원자성 — GM 턴이 중간에 실패하면 부분 실행된 도구 효과를 버리고
    // 턴 시작 시점으로 복원한다 (리뷰 발견: 부분 커밋 + 재시도 유도 → 중복 실행)
    const backup: GameState = structuredClone(state);

    state.chat.push({ role: "user", text: body.data.message, toolCalls: [], at: state.date });
    try {
      const turn = await runGmTurn(state, body.data.message);
      state.chat.push({ role: "model", text: turn.text, toolCalls: turn.toolCalls, at: state.date });
      saveGame(state);
      return NextResponse.json(toPayload(state));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      backup.chat.push({ role: "user", text: body.data.message, toolCalls: [], at: backup.date });
      backup.chat.push({
        role: "model",
        text: `@수석코치: 죄송합니다, 방금 지시는 처리하지 못했습니다 — 아무것도 반영되지 않았으니 다시 말씀해 주십시오. (${message})`,
        toolCalls: [],
        at: backup.date,
      });
      saveGame(backup);
      return NextResponse.json(toPayload(backup));
    }
  });
}
