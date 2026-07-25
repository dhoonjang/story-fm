import { NextResponse } from "next/server";
import { z } from "zod";
import { runTurnLocked } from "@/lib/turn-runner";

const TurnSchema = z.object({ message: z.string().min(1).max(1000) });

/** 유저 턴 → GM 실행 → 모델 턴 (비스트리밍 JSON). 스트리밍은 turn/stream. */
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

  const outcome = await runTurnLocked(id, body.data.message);
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  return NextResponse.json(outcome.payload);
}
