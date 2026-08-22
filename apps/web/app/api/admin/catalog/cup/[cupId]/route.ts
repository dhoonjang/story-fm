import { NextResponse } from "next/server";
import { z } from "zod";
import { MatchStageSchema, type MatchStage } from "@story-fm/domain";
import {
  DOMESTIC_STAGES,
  adminCupCatalog,
  adminUpdateCup,
  adminUpdateDomesticCup,
  isCupCatalogEdited,
  isDomesticCup,
} from "@story-fm/engine";
import { adminWrite } from "@/app/api/admin/admin-guard";

/**
 * 컵 편집 — 유럽 대항전과 국내 컵이 **한 경로**를 쓴다. 어느 쪽인지는 id로 가른다
 * (`isDomesticCup`), 대회군마다 필드가 아예 달라 스키마도 갈라진다.
 *
 * `prize`·`windows`처럼 표 전체가 통째로 교체되는 필드는 부분 갱신을 받지 않는다 —
 * 엔진이 얕은 `Object.assign`으로 얹기 때문에 반쪽 표를 받으면 나머지가 사라진다.
 */

const count = (msg: string) => z.number().int(msg).min(0, msg);
const money = z.number().min(0, "상금은 0 이상이어야 합니다");
/** 라운드별 금액 표 — 없는 단계는 비워 둔다 */
const stageMoney = z.record(MatchStageSchema, money);
/** 목표 날짜 `[월, 일]` */
const monthDay = z.tuple([
  z.number().int().min(1, "월은 1~12여야 합니다").max(12, "월은 1~12여야 합니다"),
  z.number().int().min(1, "일은 1~31이어야 합니다").max(31, "일은 1~31이어야 합니다"),
]);
/**
 * 라운드 일정 표 — 단계 목록에서 펼쳐 **전 단계를 요구한다**. 엔진이 표를 통째로
 * 갈아끼우므로 반쪽을 받으면 나머지 라운드의 목표일이 사라진다.
 */
const windows = z
  .object(
    Object.fromEntries(DOMESTIC_STAGES.map((s) => [s, monthDay])) as Record<
      string,
      typeof monthDay
    >,
  )
  .transform((v) => v as Record<MatchStage, [number, number]>);

/** 유럽 대항전 — 리그 페이즈 규모·티켓·통과 인원·상금 */
const EuroPatchSchema = z.object({
  name: z.string().min(1, "대회 이름이 필요합니다").max(60).optional(),
  short: z.string().min(1, "짧은 표기가 필요합니다").max(10).optional(),
  size: count("참가 팀 수는 0 이상의 정수여야 합니다").max(128).optional(),
  matchesPerTeam: count("팀당 경기 수는 0 이상의 정수여야 합니다").max(64).optional(),
  slots: z.record(count("티켓 수는 0 이상의 정수여야 합니다")).optional(),
  directSlots: count("직행 팀 수는 0 이상의 정수여야 합니다").max(128).optional(),
  playoffSlots: count("플레이오프 팀 수는 0 이상의 정수여야 합니다").max(128).optional(),
  prize: z
    .object({
      participation: money,
      win: money,
      draw: money,
      stage: stageMoney,
      winner: money,
    })
    .optional(),
});

/** 국내 컵 — 순수 녹아웃이라 규모 대신 추첨·홈 배정·라운드 일정이 열린다 */
const DomesticPatchSchema = z.object({
  name: z.string().min(1, "대회 이름이 필요합니다").max(60).optional(),
  short: z.string().min(1, "짧은 표기가 필요합니다").max(10).optional(),
  country: z.string().min(1, "나라가 필요합니다").max(40).optional(),
  prestige: z
    .number()
    .int("컵 명성은 1 또는 2여야 합니다")
    .min(1, "컵 명성은 1 또는 2여야 합니다")
    .max(2, "컵 명성은 1 또는 2여야 합니다")
    .transform((v) => v as 1 | 2)
    .optional(),
  twoLegged: z.array(MatchStageSchema).optional(),
  drawStyle: z.enum(["per-round", "fixed-bracket"]).optional(),
  firstDraw: monthDay.optional(),
  drawDelayDays: count("추첨 지연 일수는 0 이상의 정수여야 합니다").max(60).optional(),
  homeRule: z.enum(["underdog", "seeded", "draw"]).optional(),
  windows: windows.optional(),
  stageNames: z.record(MatchStageSchema, z.string().min(1).max(20)).optional(),
  finalMidweek: z.boolean().optional(),
  europeanTicket: z.enum(["uel", "uecl"]).optional(),
  prize: z
    .object({
      round: stageMoney,
      winner: money,
      runnerUp: money,
    })
    .optional(),
});

function payload(message: string) {
  const { europe, domestic } = adminCupCatalog();
  return { ok: true, message, europe, domestic, edited: isCupCatalogEdited() };
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** 컵 편집 — 유럽·국내 모두 이 경로를 쓴다 */
export const PATCH = adminWrite(async function (
  request: Request,
  context: { params: Promise<{ cupId: string }> },
) {
  const { cupId } = await context.params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest("잘못된 요청 본문입니다");
  }

  if (isDomesticCup(cupId)) {
    const body = DomesticPatchSchema.safeParse(raw);
    if (!body.success) return badRequest(body.error.issues[0]?.message ?? "입력 오류");
    const res = adminUpdateDomesticCup(cupId, body.data);
    if (!res.ok) return badRequest(res.message);
    return NextResponse.json(payload(res.message));
  }

  const body = EuroPatchSchema.safeParse(raw);
  if (!body.success) return badRequest(body.error.issues[0]?.message ?? "입력 오류");
  const res = adminUpdateCup(cupId, body.data);
  if (!res.ok) return badRequest(res.message);
  return NextResponse.json(payload(res.message));
});
