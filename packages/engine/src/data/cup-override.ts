import { cupCatalogPath } from "../core/paths";
import {
  asRecord,
  catalogSource,
  clearOverride,
  isNumberMap,
  readOverride,
  writeOverride,
} from "./catalog-source";
import type { CupCatalogEntry } from "./cup-catalog";
import type { DomesticCupEntry } from "./domestic-cup-catalog";

/**
 * 컵 오버라이드 — 유럽 대항전과 국내 컵을 **한 파일**(`.data/cup-catalog.json`)에
 * 담는다. 둘은 모양이 다르지만(리그 페이즈 + 녹아웃 vs 순수 녹아웃) 어드민에서는
 * 같은 화면의 두 목록이고, 대항전 티켓과 국내 컵 우승 티켓이 서로를 참조한다 —
 * 한 스냅샷으로 저장해야 반쪽만 바뀐 상태가 생기지 않는다.
 *
 * cup-catalog.ts와 domestic-cup-catalog.ts 양쪽이 읽으므로 순환 참조를 피해 여기
 * 둔다 (타입만 가져오고 런타임 의존은 없다).
 */

export interface CupOverride {
  europe: CupCatalogEntry[];
  domestic: DomesticCupEntry[];
}

const STAGES = ["league", "playoff", "r32", "r16", "qf", "sf", "final"] as const;

function isStageMap(value: unknown): boolean {
  const o = asRecord(value);
  return o !== null && Object.keys(o).every((k) => (STAGES as readonly string[]).includes(k));
}

/** `[월, 일]` 쌍 */
function isDatePair(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [month, day] = value as unknown[];
  if (typeof month !== "number" || typeof day !== "number") return false;
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function isStageList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((v) => typeof v === "string" && (STAGES as readonly string[]).includes(v))
  );
}

function isEuroEntry(value: unknown): value is CupCatalogEntry {
  const o = asRecord(value);
  if (o === null) return false;
  const prize = asRecord(o.prize);
  if (prize === null) return false;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.name === "string" &&
    typeof o.short === "string" &&
    typeof o.size === "number" &&
    typeof o.matchesPerTeam === "number" &&
    isNumberMap(o.slots) &&
    typeof o.directSlots === "number" &&
    typeof o.playoffSlots === "number" &&
    typeof prize.participation === "number" &&
    typeof prize.win === "number" &&
    typeof prize.draw === "number" &&
    typeof prize.winner === "number" &&
    isStageMap(prize.stage) &&
    isNumberMap(prize.stage)
  );
}

function isDomesticEntry(value: unknown): value is DomesticCupEntry {
  const o = asRecord(value);
  if (o === null) return false;
  const prize = asRecord(o.prize);
  const windows = asRecord(o.windows);
  if (prize === null || windows === null) return false;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.name === "string" &&
    typeof o.short === "string" &&
    typeof o.country === "string" &&
    (o.prestige === 1 || o.prestige === 2) &&
    isStageList(o.twoLegged) &&
    (o.drawStyle === "per-round" || o.drawStyle === "fixed-bracket") &&
    isDatePair(o.firstDraw) &&
    typeof o.drawDelayDays === "number" &&
    (o.homeRule === "underdog" || o.homeRule === "seeded" || o.homeRule === "draw") &&
    isStageMap(windows) &&
    Object.values(windows).every(isDatePair) &&
    (o.stageNames === undefined || isStageMap(o.stageNames)) &&
    (o.finalMidweek === undefined || typeof o.finalMidweek === "boolean") &&
    (o.europeanTicket === "uel" || o.europeanTicket === "uecl") &&
    isStageMap(prize.round) &&
    isNumberMap(prize.round) &&
    typeof prize.winner === "number" &&
    typeof prize.runnerUp === "number"
  );
}

const load = catalogSource<CupOverride | null>(() => {
  const o = asRecord(readOverride(cupCatalogPath()));
  if (o === null) return null;
  if (!Array.isArray(o.europe) || !o.europe.every(isEuroEntry)) return null;
  if (!Array.isArray(o.domestic) || !o.domestic.every(isDomesticEntry)) return null;
  return { europe: o.europe as CupCatalogEntry[], domestic: o.domestic as DomesticCupEntry[] };
});

/** 컵 오버라이드 — 없거나 손상됐으면 null (시드로 폴백) */
export function readCupOverride(): CupOverride | null {
  return load();
}

export function writeCupOverride(override: CupOverride): void {
  writeOverride(cupCatalogPath(), override);
}

export function clearCupOverride(): void {
  clearOverride(cupCatalogPath());
}
