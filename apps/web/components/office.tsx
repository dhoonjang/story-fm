"use client";

import { useMemo, useState } from "react";
import type { OfficeViews } from "@story-fm/engine";
import type { GamePayload } from "@/lib/store";

const money = (n: number) => `£${(n / 1e6).toFixed(1)}M`;


/** 세부 포지션 코드 → 그룹 (엔진 skills.ts POSITION_GROUP과 동일 규칙) */
const GROUP_OF: Record<string, "GK" | "DF" | "MF" | "FW"> = {
  GK: "GK",
  RB: "DF", RWB: "DF", RCB: "DF", CB: "DF", LCB: "DF", LB: "DF", LWB: "DF",
  DM: "MF", CDM: "MF", CM: "MF", RCM: "MF", LCM: "MF", AM: "MF", CAM: "MF", RM: "MF", LM: "MF",
  RW: "FW", LW: "FW", SS: "FW", ST: "FW", CF: "FW",
};

/** 포메이션별 전술판 슬롯 — x: 좌→우 %, y: 상단(공격)→하단(자기 골문) % */
const FORMATION_LAYOUTS: Record<string, Array<{ code: string; x: number; y: number }>> = {
  "4-3-3": [
    { code: "GK", x: 50, y: 90 },
    { code: "RB", x: 84, y: 71 },
    { code: "RCB", x: 62, y: 76 },
    { code: "LCB", x: 38, y: 76 },
    { code: "LB", x: 16, y: 71 },
    { code: "CDM", x: 50, y: 57 },
    { code: "RCM", x: 68, y: 44 },
    { code: "LCM", x: 32, y: 44 },
    { code: "RW", x: 82, y: 25 },
    { code: "ST", x: 50, y: 16 },
    { code: "LW", x: 18, y: 25 },
  ],
  "4-4-2": [
    { code: "GK", x: 50, y: 90 },
    { code: "RB", x: 84, y: 71 },
    { code: "RCB", x: 62, y: 76 },
    { code: "LCB", x: 38, y: 76 },
    { code: "LB", x: 16, y: 71 },
    { code: "RM", x: 84, y: 45 },
    { code: "RCM", x: 62, y: 49 },
    { code: "LCM", x: 38, y: 49 },
    { code: "LM", x: 16, y: 45 },
    { code: "ST", x: 62, y: 19 },
    { code: "ST", x: 38, y: 19 },
  ],
  "4-2-3-1": [
    { code: "GK", x: 50, y: 90 },
    { code: "RB", x: 84, y: 71 },
    { code: "RCB", x: 62, y: 76 },
    { code: "LCB", x: 38, y: 76 },
    { code: "LB", x: 16, y: 71 },
    { code: "CDM", x: 62, y: 55 },
    { code: "CDM", x: 38, y: 55 },
    { code: "RW", x: 80, y: 33 },
    { code: "CAM", x: 50, y: 31 },
    { code: "LW", x: 20, y: 33 },
    { code: "ST", x: 50, y: 14 },
  ],
  "3-5-2": [
    { code: "GK", x: 50, y: 90 },
    { code: "RCB", x: 72, y: 76 },
    { code: "CB", x: 50, y: 79 },
    { code: "LCB", x: 28, y: 76 },
    { code: "RWB", x: 88, y: 49 },
    { code: "RCM", x: 64, y: 45 },
    { code: "CDM", x: 50, y: 57 },
    { code: "LCM", x: 36, y: 45 },
    { code: "LWB", x: 12, y: 49 },
    { code: "ST", x: 60, y: 17 },
    { code: "ST", x: 40, y: 17 },
  ],
  "5-4-1": [
    { code: "GK", x: 50, y: 90 },
    { code: "RWB", x: 88, y: 65 },
    { code: "RCB", x: 68, y: 77 },
    { code: "CB", x: 50, y: 80 },
    { code: "LCB", x: 32, y: 77 },
    { code: "LWB", x: 12, y: 65 },
    { code: "RM", x: 80, y: 43 },
    { code: "RCM", x: 58, y: 47 },
    { code: "LCM", x: 42, y: 47 },
    { code: "LM", x: 20, y: 43 },
    { code: "ST", x: 50, y: 16 },
  ],
};
const FORMATIONS = Object.keys(FORMATION_LAYOUTS);

function AttrBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="attr-row">
      <span>{label}</span>
      <div className="attr-bar">
        <div style={{ width: `${value}%` }} />
      </div>
      <span>{value}</span>
    </div>
  );
}

// ── 스쿼드 (전술판 · 전술 · 명단) ─────────────────────────
type SquadRow = OfficeViews["squad"]["players"][number];
type TacticsView = OfficeViews["squad"]["tactics"];
type Selection = { kind: "slot"; index: number } | { kind: "bench"; id: string } | null;

/** 능력치 15축 라벨 — 선택한 선수의 강점을 보여줄 때 쓴다 */
const AXIS_KO: Record<string, string> = {
  pace: "스피드",
  stamina: "체력",
  strength: "몸싸움",
  aerial: "공중볼",
  finishing: "결정력",
  dribbling: "드리블",
  passing: "패스",
  kicking: "킥력",
  tackling: "태클",
  vision: "시야",
  positioning: "위치선정",
  composure: "침착성",
  aggression: "적극성",
  leadership: "리더십",
  goalkeeping: "골키핑",
};
const AXES = Object.keys(AXIS_KO);

/**
 * 전술 5축 — 값 1~5의 뜻을 말로 보여준다. 슬라이더 숫자만 두면 "3이 뭔데?"가 된다.
 * 라벨 문구는 GM이 이해하는 축(match-sim §1)과 같은 뜻이어야 한다.
 */
const TACTIC_AXES = [
  {
    key: "mentality" as const,
    label: "멘탈리티",
    values: ["매우 수비적", "수비적", "균형", "공격적", "매우 공격적"],
  },
  {
    key: "defensiveLine" as const,
    label: "수비 라인",
    values: ["매우 낮게", "낮게", "보통", "높게", "매우 높게"],
  },
  {
    key: "pressing" as const,
    label: "압박",
    values: ["최소", "약하게", "보통", "강하게", "맹렬히"],
  },
  {
    key: "tempo" as const,
    label: "템포",
    values: ["매우 느리게", "느리게", "보통", "빠르게", "매우 빠르게"],
  },
  {
    key: "width" as const,
    label: "공격 폭",
    values: ["매우 좁게", "좁게", "보통", "넓게", "매우 넓게"],
  },
];
const PASS_STYLES = [
  { value: "short", label: "짧은 패스" },
  { value: "mixed", label: "혼합" },
  { value: "direct", label: "롱볼" },
];
const passStyleLabel = (v: string) => PASS_STYLES.find((p) => p.value === v)?.label ?? v;

/** 사실상 같은 자리 묶음 — 엔진 `proficiencyAt`의 표시용 거울 (domain POSITION_CLUSTERS) */
const POSITION_CLUSTERS: string[][] = [
  ["RCB", "CB", "LCB"],
  ["RCM", "CM", "LCM"],
  ["DM", "CDM"],
  ["AM", "CAM"],
];

/**
 * 이 선수가 그 자리에서 갖는 적응도(표시용) — 엔진 `proficiencyAt`과 같은 규칙:
 * 정확 일치 → 같은 묶음(−2) → 같은 라인(55) → 생소(35).
 */
function fitAt(p: SquadRow, code: string): { value: number; exact: boolean } {
  const exact = p.positions.find((x) => x.position === code);
  if (exact) return { value: exact.proficiency, exact: true };
  const cluster = POSITION_CLUSTERS.find((c) => c.includes(code));
  const near = cluster ? p.positions.filter((x) => cluster.includes(x.position)) : [];
  if (near.length > 0) {
    return { value: Math.max(...near.map((x) => x.proficiency)) - 2, exact: false };
  }
  return { value: GROUP_OF[code] === p.positionGroup ? 55 : 35, exact: false };
}

const fitClass = (v: number) => (v >= 80 ? "good" : v >= 60 ? "ok" : "bad");

/** 현재 선발을 레이아웃 슬롯에 배치 — 배치 포지션 정확 일치 → 그룹 일치 → 순서 */
function assignSlots(
  layout: Array<{ code: string; x: number; y: number }>,
  xi: SquadRow[],
): Array<string | null> {
  const remaining = [...xi];
  const slots: Array<string | null> = layout.map(() => null);
  // 1차: 전술 배치 포지션이 슬롯 코드와 같은 선수
  layout.forEach((slot, i) => {
    const idx = remaining.findIndex((p) => p.assignedPosition === slot.code);
    if (idx >= 0) slots[i] = remaining.splice(idx, 1)[0]!.id;
  });
  // 2차: 포지션 그룹이 맞는 선수
  layout.forEach((slot, i) => {
    if (slots[i] !== null) return;
    const group = GROUP_OF[slot.code];
    const idx = remaining.findIndex((p) => p.positionGroup === group);
    if (idx >= 0) slots[i] = remaining.splice(idx, 1)[0]!.id;
  });
  layout.forEach((_, i) => {
    if (slots[i] === null && remaining.length > 0) slots[i] = remaining.shift()!.id;
  });
  return slots;
}

/** 전술 변경 폭 → 적응도 하락 (엔진 `tacticsChangeDrop`의 거울 — 저장 전에 미리 보인다) */
function expectedDrop(before: TacticsView, after: TacticsView): number {
  let drop = before.formation !== after.formation ? 25 : 0;
  for (const axis of TACTIC_AXES) drop += Math.abs(before[axis.key] - after[axis.key]) * 4;
  if (before.passStyle !== after.passStyle) drop += 6;
  return drop;
}

/** 상태 막대 — 폼·사기·피로를 숫자와 함께 눈으로 (피로는 높을수록 나쁘다) */
function StatBar({
  value,
  max = 100,
  kind,
}: {
  value: number;
  max?: number;
  kind: "form" | "morale" | "fatigue";
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <span className={`stat-bar ${kind}`} title={`${value}`}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

/** 선수 상태 배지 묶음 — 표·상세·전술판이 같은 규칙을 쓴다 */
function StatusBadges({ p }: { p: SquadRow }) {
  return (
    <>
      {p.injury && (
        <span
          className="badge warn"
          title={`${p.injury.bodyPart} · ${p.injury.severity} · 복귀 예상 ${p.injury.expectedReturn}`}
        >
          부상
        </span>
      )}
      {p.suspended > 0 && <span className="badge warn">정지 {p.suspended}</span>}
      {p.hasIssue && <span className="badge warn">불만</span>}
      {p.adaptationDaysLeft > 0 && (
        <span className="badge" title={`적응 완료까지 약 ${p.adaptationDaysLeft}일 — 수치는 추정치다`}>
          적응 중
        </span>
      )}
    </>
  );
}

/** 전술 패널 — 읽기 모드에선 값의 뜻만, 편집 모드에선 5단계 선택 */
function TacticsPanel({
  tactics,
  editing,
  familiarity,
  drop,
  onChange,
}: {
  tactics: TacticsView;
  editing: boolean;
  familiarity: number;
  drop: number;
  onChange: (patch: Partial<TacticsView>) => void;
}) {
  return (
    <div className="tactics-panel" data-testid="tactics-panel">
      <div className="tactics-head">
        <b>전술</b>
        <span className="muted">
          전술 적응도 {familiarity}
          {editing && drop > 0 && (
            <b className="drop" data-testid="tactics-drop">
              {" "}
              · 저장 시 −{drop}
            </b>
          )}
        </span>
      </div>
      <div className="tactics-grid">
        {TACTIC_AXES.map((axis) => {
          const value = tactics[axis.key];
          return (
            <div className="tactic-row" key={axis.key}>
              <span className="tactic-label">{axis.label}</span>
              {editing ? (
                <div className="tactic-steps" role="group" aria-label={axis.label}>
                  {axis.values.map((label, i) => (
                    <button
                      key={label}
                      className={`tactic-step${value === i + 1 ? " on" : ""}`}
                      onClick={() => onChange({ [axis.key]: i + 1 } as Partial<TacticsView>)}
                      title={label}
                      data-testid={`tactic-${axis.key}-${i + 1}`}
                    >
                      {i + 1}
                    </button>
                  ))}
                  <span className="tactic-value">{axis.values[value - 1]}</span>
                </div>
              ) : (
                <span className="tactic-value read">
                  <span className="tactic-meter">
                    <span style={{ width: `${(value / 5) * 100}%` }} />
                  </span>
                  {axis.values[value - 1]}
                </span>
              )}
            </div>
          );
        })}
        <div className="tactic-row">
          <span className="tactic-label">패스</span>
          {editing ? (
            <div className="tactic-steps" role="group" aria-label="패스 스타일">
              {PASS_STYLES.map((s) => (
                <button
                  key={s.value}
                  className={`tactic-step wide${tactics.passStyle === s.value ? " on" : ""}`}
                  onClick={() => onChange({ passStyle: s.value })}
                  data-testid={`tactic-pass-${s.value}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          ) : (
            <span className="tactic-value read">{passStyleLabel(tactics.passStyle)}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** 선택한 선수 상세 — 그 자리 적응도와 강점 5축 */
function PlayerDetail({ p, slotCode }: { p: SquadRow; slotCode: string | null }) {
  const fit = slotCode ? fitAt(p, slotCode) : null;
  const top = AXES.map((a) => ({ a, v: (p as unknown as Record<string, number>)[a] ?? 0 }))
    .sort((x, y) => y.v - x.v)
    .slice(0, 5);
  return (
    <div className="player-detail" data-testid="player-detail">
      <div className="pd-head">
        <b>
          {p.isCaptain ? "Ⓒ " : ""}
          {p.name}
        </b>
        <span className="muted">
          {p.age}세 · {p.position} · OVR {p.overall}
          {p.potential > p.overall ? ` (POT ${p.potential})` : ""}
        </span>
        <StatusBadges p={p} />
      </div>
      <div className="pd-grid">
        {fit && (
          <div className="pd-cell">
            <span className="muted">{slotCode} 적응도</span>
            <b className={`fit ${fitClass(fit.value)}`}>
              {fit.value}
              {!fit.exact && <span className="est" title="본 포지션이 아니라 추정치다">?</span>}
            </b>
          </div>
        )}
        <div className="pd-cell">
          <span className="muted">폼</span>
          <b>{p.form > 0 ? `+${p.form}` : p.form}</b>
        </div>
        <div className="pd-cell">
          <span className="muted">사기</span>
          <b>{p.morale}</b>
        </div>
        <div className="pd-cell">
          <span className="muted">피로</span>
          <b>{p.fatigue}</b>
        </div>
        <div className="pd-cell">
          <span className="muted">전술 적응</span>
          <b>{p.role === "스쿼드" ? "—" : p.familiarity}</b>
        </div>
        <div className="pd-cell">
          <span className="muted">시즌</span>
          <b>
            {p.seasonApps}경기 {p.seasonGoals}골
          </b>
        </div>
      </div>
      <div className="pd-axes">
        {top.map(({ a, v }) => (
          <span className="pd-axis" key={a}>
            {AXIS_KO[a]} <b>{v}</b>
          </span>
        ))}
      </div>
      <div className="pd-foot muted">
        가능 포지션 {p.positions.map((x) => `${x.position} ${x.proficiency}`).join(" · ")}
        {p.instruction ? ` · 개인 지시 "${p.instruction}"` : ""}
      </div>
    </div>
  );
}

export function SquadView({
  game,
  onUpdate,
  onGoToChat,
}: {
  game: GamePayload;
  onUpdate: (payload: GamePayload) => void;
  onGoToChat: () => void;
}) {
  const squad = game.views.squad;
  const players = squad.players;
  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const [editing, setEditing] = useState(false);
  const [formation, setFormation] = useState(squad.formation);
  const [tactics, setTactics] = useState<TacticsView>(squad.tactics);
  const [slots, setSlots] = useState<Array<string | null>>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [benchSet, setBenchSet] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "role", desc: false });

  const MAX_BENCH = 9;
  const shownFormation = editing ? formation : squad.formation;
  const layout = FORMATION_LAYOUTS[shownFormation] ?? FORMATION_LAYOUTS["4-3-3"]!;

  // 읽기 모드의 전술판은 저장된 배치에서 그린다 (편집 상태에 의존하지 않는다)
  const readSlots = useMemo(
    () =>
      assignSlots(
        FORMATION_LAYOUTS[squad.formation] ?? FORMATION_LAYOUTS["4-3-3"]!,
        players.filter((p) => p.role === "선발"),
      ),
    [players, squad.formation],
  );
  const boardSlots = editing ? slots : readSlots;
  const slotSet = new Set(boardSlots.filter(Boolean) as string[]);
  const benchPlayers = players.filter((p) => !slotSet.has(p.id));
  const benchDesignated = benchPlayers.filter((p) => benchSet.has(p.id));

  function startEdit() {
    const fm = FORMATIONS.includes(squad.formation) ? squad.formation : "4-3-3";
    setFormation(fm);
    setTactics(squad.tactics);
    setSlots(assignSlots(FORMATION_LAYOUTS[fm]!, players.filter((p) => p.role === "선발")));
    setBenchSet(new Set(players.filter((p) => p.role === "벤치").map((p) => p.id)));
    setSelection(null);
    setSaveError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setSelection(null);
    setSaveError(null);
    setFormation(squad.formation);
    setTactics(squad.tactics);
  }

  /** 비선발 선수를 매치데이 벤치(최대 9)로 지정/해제 — 나머지는 예비 스쿼드 */
  function toggleBench(id: string) {
    setBenchSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (benchPlayers.filter((p) => next.has(p.id)).length < MAX_BENCH) next.add(id);
      return next;
    });
  }

  function changeFormation(next: string) {
    const nextLayout = FORMATION_LAYOUTS[next];
    if (!nextLayout) return;
    const currentXI = slots
      .filter((id): id is string => id !== null)
      .map((id) => byId.get(id))
      .filter((p): p is SquadRow => p !== undefined);
    setFormation(next);
    setSlots(assignSlots(nextLayout, currentXI));
    setSelection(null);
  }

  /**
   * 선택-스왑: 슬롯↔슬롯은 자리 교환, 슬롯↔벤치는 선수 교체.
   *
   * 이미 선발인 선수를 "벤치 쪽 선택"으로 다른 자리에 넣으면 같은 선수가 두 자리에
   * 앉는다(명단 표에서 선발을 고른 뒤 슬롯을 누르는 경로). 그 경우는 자리 교환으로 돌린다.
   */
  function applySwap(a: Selection, b: Selection) {
    if (!a || !b || !editing) return;
    if (a.kind === "bench" && b.kind === "bench") return;
    if (a.kind === "bench" && b.kind === "slot") {
      const already = slots.indexOf(a.id);
      if (already >= 0) return applySwap({ kind: "slot", index: already }, b);
    }
    if (b.kind === "bench" && a.kind === "slot") {
      const already = slots.indexOf(b.id);
      if (already >= 0) return applySwap(a, { kind: "slot", index: already });
    }
    setSlots((prev) => {
      const next = [...prev];
      if (a.kind === "slot" && b.kind === "slot") {
        const tmp = next[a.index] ?? null;
        next[a.index] = next[b.index] ?? null;
        next[b.index] = tmp;
      } else if (a.kind === "slot" && b.kind === "bench") {
        next[a.index] = b.id;
      } else if (a.kind === "bench" && b.kind === "slot") {
        next[b.index] = a.id;
      }
      return next;
    });
    // 선발로 올라간 선수는 벤치 지정에서 빼고, 내려온 선수는 벤치에 넣는다
    const promoted = a.kind === "bench" ? a.id : b.kind === "bench" ? b.id : null;
    const demotedIndex = a.kind === "slot" && b.kind === "bench" ? a.index : b.kind === "slot" && a.kind === "bench" ? b.index : null;
    const demoted = demotedIndex !== null ? (slots[demotedIndex] ?? null) : null;
    if (promoted || demoted) {
      setBenchSet((prev) => {
        const next = new Set(prev);
        if (promoted) next.delete(promoted);
        if (demoted && next.size < MAX_BENCH) next.add(demoted);
        return next;
      });
    }
    setSelection(null);
  }

  function clickSlot(index: number) {
    if (!editing) {
      // 읽기 모드에선 선택이 곧 상세 보기다
      const id = boardSlots[index];
      setSelection(id ? { kind: "slot", index } : null);
      return;
    }
    const here: Selection = { kind: "slot", index };
    if (!selection) return setSelection(here);
    if (selection.kind === "slot" && selection.index === index) return setSelection(null);
    applySwap(selection, here);
  }

  function clickBench(id: string) {
    const here: Selection = { kind: "bench", id };
    if (!editing) return setSelection(selection?.kind === "bench" && selection.id === id ? null : here);
    if (!selection) return setSelection(here);
    if (selection.kind === "bench") return setSelection(selection.id === id ? null : here);
    applySwap(selection, here);
  }

  const dragData = (sel: Exclude<Selection, null>) => JSON.stringify(sel);
  const readDrag = (e: React.DragEvent): Selection => {
    try {
      return JSON.parse(e.dataTransfer.getData("text/plain")) as Selection;
    } catch {
      return null;
    }
  };

  const gkSlotIdx = layout.findIndex((s) => s.code === "GK");
  const gkOccupant = gkSlotIdx >= 0 ? byId.get(boardSlots[gkSlotIdx] ?? "") : undefined;
  const gkWarning = editing && gkOccupant && gkOccupant.positionGroup !== "GK";
  const xi = boardSlots
    .map((id) => (id ? byId.get(id) : undefined))
    .filter((p): p is SquadRow => p !== undefined);
  const unavailableInXI = xi.filter((p) => !p.available);
  const unavailableOnBench = benchDesignated.filter((p) => !p.available);
  const xiRating = xi.length > 0 ? Math.round(xi.reduce((s, p) => s + p.overall, 0) / xi.length) : 0;
  const misfits = editing
    ? boardSlots
        .map((id, i) => ({ p: id ? byId.get(id) : undefined, code: layout[i]?.code }))
        .filter((x) => x.p && x.code && fitAt(x.p, x.code).value < 50)
    : [];
  const drop = editing ? expectedDrop(squad.tactics, { ...tactics, formation }) : 0;

  const selectedPlayer =
    selection?.kind === "slot"
      ? byId.get(boardSlots[selection.index] ?? "")
      : selection?.kind === "bench"
        ? byId.get(selection.id)
        : undefined;
  const selectedSlotCode = selection?.kind === "slot" ? (layout[selection.index]?.code ?? null) : null;

  async function save() {
    setSaving(true);
    setSaveError(null);
    // v6: 선발은 {playerId, position} 배치로 보낸다 (전술판 슬롯 = 배치 포지션)
    const starting = slots
      .map((id, i) => (id ? { playerId: id, position: layout[i]!.code } : null))
      .filter((x): x is { playerId: string; position: string } => x !== null);
    const bench = benchDesignated.map((p) => ({ playerId: p.id }));
    // 포메이션은 별도 필드로 보낸다 (라우트가 setTactics를 한 번만 호출하게)
    const { formation: _formation, ...axes } = tactics;
    void _formation;
    try {
      const res = await fetch(`/api/games/${game.id}/lineup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starting, bench, formation, tactics: axes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "저장 실패");
      onUpdate(data);
      setEditing(false);
      setSelection(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const chipClass = (p: SquadRow | undefined, selected: boolean) =>
    `pitch-chip${selected ? " selected" : ""}${p && !p.available ? " unavailable" : ""}`;

  return (
    <div data-testid="view-squad">
      <div className="squad-head">
        <div className="squad-summary">
          <span>
            <b>{shownFormation}</b> · 선발 평균 <b>{xiRating}</b>
          </span>
          <span className="muted">
            매치데이 {xi.length + (editing ? benchDesignated.length : players.filter((p) => p.role === "벤치").length)}인 ·
            스쿼드 {players.length}명
          </span>
        </div>
        {squad.editable && !editing && (
          <button className="ghost-btn" onClick={startEdit} data-testid="edit-lineup">
            전술판 편집
          </button>
        )}
        {!squad.editable && (
          <button className="ghost-btn" onClick={onGoToChat}>
            경기 중 — 채팅으로
          </button>
        )}
      </div>

      {(gkWarning || unavailableInXI.length > 0 || unavailableOnBench.length > 0 || misfits.length > 0 || saveError) && (
        <div className="lineup-status warn" data-testid="lineup-status">
          {gkWarning && <div>⚠ GK 자리에 필드 플레이어 — 저장하면 그 선수가 골키퍼가 됩니다.</div>}
          {unavailableInXI.length > 0 && (
            <div>⚠ 선발 불가(부상·정지): {unavailableInXI.map((p) => p.name).join(", ")} — 교체하세요.</div>
          )}
          {unavailableOnBench.length > 0 && (
            <div>⚠ 벤치에 출전 불가 선수: {unavailableOnBench.map((p) => p.name).join(", ")}</div>
          )}
          {misfits.length > 0 && (
            <div>
              ⚠ 낯선 자리: {misfits.map((x) => `${x.p!.name}(${x.code})`).join(", ")} — 적응도가 낮으면 경기력이
              떨어집니다.
            </div>
          )}
          {saveError && <div data-testid="lineup-error">{saveError}</div>}
        </div>
      )}

      <div className="squad-layout">
        <div className="squad-board-col">
          {/* board-toolbar는 편집 중에만 있다 — e2e가 이 testid로 편집 모드를 본다 */}
          {editing && (
            <div className="board-toolbar" data-testid="lineup-editor">
              <label>
                포메이션{" "}
                <select
                  value={formation}
                  onChange={(e) => changeFormation(e.target.value)}
                  data-testid="formation-select"
                >
                  {FORMATIONS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
              <div className="board-actions">
                <button
                  className="primary-btn"
                  onClick={save}
                  disabled={saving || slots.some((s) => s === null)}
                  data-testid="save-lineup"
                >
                  {saving ? "저장 중…" : "저장"}
                </button>
                <button className="ghost-btn" onClick={cancelEdit} disabled={saving}>
                  취소
                </button>
              </div>
            </div>
          )}

          <div className={`pitch-board${editing ? " editing" : ""}`} data-testid="pitch-board">
            <div className="pitch-lines" />
            <div className="pitch-box top" />
            <div className="pitch-box small top" />
            <div className="pitch-box bottom" />
            <div className="pitch-box small bottom" />
            <span className="pitch-zone" style={{ top: "6%" }}>
              공격
            </span>
            <span className="pitch-zone" style={{ top: "46%" }}>
              중원
            </span>
            <span className="pitch-zone" style={{ top: "84%" }}>
              수비
            </span>
            {layout.map((slot, i) => {
              const p = byId.get(boardSlots[i] ?? "");
              const selected = selection?.kind === "slot" && selection.index === i;
              const fit = p ? fitAt(p, slot.code) : null;
              return (
                <button
                  key={i}
                  className={`pitch-slot ${chipClass(p, selected)}`}
                  style={{ left: `${slot.x}%`, top: `${slot.y}%` }}
                  onClick={() => clickSlot(i)}
                  draggable={editing}
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", dragData({ kind: "slot", index: i }))}
                  onDragOver={(e) => editing && e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    applySwap(readDrag(e), { kind: "slot", index: i });
                  }}
                  data-testid={`slot-${i}`}
                  title={p ? `${p.name} · ${slot.code} 적응도 ${fit?.value}` : slot.code}
                >
                  <span className="slot-pos">{slot.code}</span>
                  <span className="slot-name">
                    {p?.isCaptain ? "Ⓒ" : ""}
                    {p?.name ?? "—"}
                  </span>
                  <span className="slot-meta">
                    <b>{p?.overall ?? ""}</b>
                    {fit && <span className={`fit ${fitClass(fit.value)}`}>{fit.value}</span>}
                    {p && !p.available && <span className="slot-flag">✖</span>}
                    {p?.hasIssue && <span className="slot-flag warn">!</span>}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="hint">
            {editing
              ? "선수를 탭해 선택한 뒤 다른 자리를 탭하면 자리를 바꿉니다 (드래그도 됩니다). 슬롯의 포지션이 그 선수의 배치 포지션이 되고, 자리 적응도는 칩 오른쪽 숫자입니다."
              : "자리를 탭하면 선수 상세가 열립니다. 라인업·전술을 바꾸려면 전술판 편집을 누르세요."}
          </p>
        </div>

        <div className="squad-side-col">
          <TacticsPanel
            tactics={editing ? { ...tactics, formation } : squad.tactics}
            editing={editing}
            familiarity={squad.familiarity}
            drop={drop}
            onChange={(patch) => setTactics((t) => ({ ...t, ...patch }))}
          />
          {selectedPlayer && <PlayerDetail p={selectedPlayer} slotCode={selectedSlotCode} />}
        </div>
      </div>

      {editing && (
        <>
          <div className="section-title" data-testid="bench-count">
            벤치 {benchDesignated.length}/{MAX_BENCH} · 예비 {benchPlayers.length - benchDesignated.length}
            <span className="hint" style={{ fontWeight: 400 }}>
              {" "}
              — 탭해 선발과 교체 · 배지로 벤치/예비 지정
            </span>
          </div>
          <div
            className="bench-row"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              // 선발을 벤치 영역에 떨어뜨리면 그 자리를 비우는 대신 스왑 대상이 없으므로
              // 벤치 지정만 바꾼다 (자리 교환은 칩 위에 떨어뜨려야 한다)
              const from = readDrag(e);
              if (from?.kind === "slot") {
                const id = slots[from.index];
                if (id) toggleBench(id);
              }
            }}
          >
            {benchPlayers.map((p) => {
              const selected = selection?.kind === "bench" && selection.id === p.id;
              const onBench = benchSet.has(p.id);
              return (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  className={`bench-chip ${chipClass(p, selected)}${onBench ? " on-bench" : ""}`}
                  onClick={() => clickBench(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      clickBench(p.id);
                    }
                  }}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", dragData({ kind: "bench", id: p.id }))}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    applySwap(readDrag(e), { kind: "bench", id: p.id });
                  }}
                  data-testid={`bench-${p.id}`}
                >
                  <span className="slot-pos">{p.position}</span>
                  <span className="slot-name">{p.name}</span>
                  <span className="slot-meta">
                    <b>{p.overall}</b>
                    {!p.available && (
                      <span className="slot-flag" title={p.injury ? `부상(${p.injury.bodyPart})` : `정지 ${p.suspended}경기`}>
                        ✖
                      </span>
                    )}
                  </span>
                  <button
                    className={`bench-toggle${onBench ? " on" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleBench(p.id);
                    }}
                    data-testid={`benchtoggle-${p.id}`}
                    title={onBench ? "매치데이 벤치에서 빼기 → 예비" : "매치데이 벤치에 넣기"}
                  >
                    {onBench ? "벤치" : "예비"}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="section-title">명단 {players.length}명</div>
      <SquadTable
        players={players}
        sort={sort}
        onSort={(key) => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}
        selectedId={selectedPlayer?.id ?? null}
        onSelect={(id) => {
          const onBoard = boardSlots.indexOf(id);
          const next: Selection = onBoard >= 0 ? { kind: "slot", index: onBoard } : { kind: "bench", id };
          const same =
            (selection?.kind === "slot" && selection.index === onBoard) ||
            (selection?.kind === "bench" && selection.id === id);
          setSelection(same ? null : next);
        }}
      />
    </div>
  );
}

type SortKey = "role" | "name" | "position" | "overall" | "age" | "form" | "morale" | "fatigue" | "goals";
const ROLE_ORDER: Record<string, number> = { 선발: 0, 벤치: 1, 스쿼드: 2 };
const GROUP_ORDER: Record<string, number> = { GK: 0, DF: 1, MF: 2, FW: 3 };

/** 명단 표 — 열 머리를 눌러 정렬한다. 기본은 역할 → 포지션 라인 → OVR */
function SquadTable({
  players,
  sort,
  onSort,
  selectedId,
  onSelect,
}: {
  players: SquadRow[];
  sort: { key: SortKey; desc: boolean };
  onSort: (key: SortKey) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const rows = useMemo(() => {
    const dir = sort.desc ? -1 : 1;
    const value = (p: SquadRow): number | string => {
      switch (sort.key) {
        case "name":
          return p.name;
        case "position":
          return (GROUP_ORDER[p.positionGroup] ?? 9) * 100 + p.overall;
        case "overall":
          return p.overall;
        case "age":
          return p.age;
        case "form":
          return p.form;
        case "morale":
          return p.morale;
        case "fatigue":
          return p.fatigue;
        case "goals":
          return p.seasonGoals;
        default:
          return (ROLE_ORDER[p.role] ?? 9) * 1000 + (GROUP_ORDER[p.positionGroup] ?? 9) * 100 - p.overall;
      }
    };
    return [...players].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y)) * dir;
      return (x - y) * dir;
    });
  }, [players, sort]);

  const th = (key: SortKey, label: string, className?: string) => (
    <th
      className={`${className ?? ""}${sort.key === key ? " sorted" : ""}`}
      onClick={() => onSort(key)}
      title="정렬"
    >
      {label}
      {sort.key === key && <span className="sort-mark">{sort.desc ? "▼" : "▲"}</span>}
    </th>
  );

  return (
    <table className="squad-table" data-testid="squad-table">
      <thead>
        <tr>
          {th("name", "선수")}
          {th("position", "포지션")}
          {th("age", "나이", "hide-sm")}
          {th("overall", "OVR")}
          <th className="hide-sm" title="이 전술에 대한 적응도">
            적응
          </th>
          {th("form", "폼")}
          {th("morale", "사기")}
          {th("fatigue", "피로")}
          {th("goals", "골", "hide-sm")}
          <th></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr
            key={p.id}
            className={`${p.role === "선발" ? "starter" : ""}${selectedId === p.id ? " picked" : ""}`}
            onClick={() => onSelect(p.id)}
            data-testid={`squad-row-${p.id}`}
          >
            <td>
              {p.isCaptain ? "Ⓒ " : ""}
              {p.name}
            </td>
            <td>
              {p.position}
              {p.assignedPosition && p.assignedPosition !== p.position && (
                <span className="assigned" title="이 전술에서 맡는 자리">
                  →{p.assignedPosition}
                </span>
              )}
            </td>
            <td className="hide-sm">{p.age}</td>
            <td title={p.adaptationDaysLeft > 0 ? "적응 중 — 아직 정확한 수치가 아니다" : undefined}>
              {p.overall}
              {p.adaptationDaysLeft > 0 && <span className="est">?</span>}
            </td>
            <td className="hide-sm">{p.role === "스쿼드" ? "—" : p.familiarity}</td>
            <td>{p.form > 0 ? `+${p.form}` : p.form}</td>
            <td>
              <StatBar value={p.morale} kind="morale" />
            </td>
            <td>
              <StatBar value={p.fatigue} kind="fatigue" />
            </td>
            <td className="hide-sm">{p.seasonGoals}</td>
            <td className="squad-badges">
              <StatusBadges p={p} />
              <span className="badge">{p.role}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── 달력 (일정 축: 경기·훈련·이적창 + 일자 상세) ─────────────
function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type CalEntry = OfficeViews["calendar"]["entries"][number];

export function CalendarView({ calendar }: { calendar: OfficeViews["calendar"] }) {
  const [selected, setSelected] = useState<string | null>(null);

  // 날짜 → 일정 엔트리 목록 (한 날에 여러 개 가능: 훈련 오전/오후 + 경기)
  const byDate = useMemo(() => {
    const map = new Map<string, CalEntry[]>();
    for (const e of calendar.entries) {
      const list = map.get(e.date) ?? [];
      list.push(e);
      map.set(e.date, list);
    }
    return map;
  }, [calendar.entries]);

  // 달력 범위 — 프리시즌 시작(7/1)부터 시즌 마지막 경기까지
  const start = new Date(`${calendar.preseasonStart}T00:00:00Z`);
  const end = new Date(`${calendar.seasonEnd}T00:00:00Z`);
  const months: Array<{ year: number; month: number }> = [];
  let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const stop = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cur <= stop) {
    months.push({ year: cur.getUTCFullYear(), month: cur.getUTCMonth() });
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
  }

  const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
  const dowOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
  const matchOf = (iso: string) => byDate.get(iso)?.find((e) => e.type === "match");
  const trainingOf = (iso: string) => (byDate.get(iso) ?? []).filter((e) => e.type === "training");
  const windowOf = (iso: string) =>
    byDate.get(iso)?.find((e) => e.type === "window-open" || e.type === "window-close");

  const detail = selected
    ? {
        iso: selected,
        dow: dowOf(selected),
        entries: byDate.get(selected) ?? [],
        events: calendar.events[selected] ?? [],
        isPast: selected < calendar.today,
      }
    : null;

  const openWindow = calendar.windows.find((w) => w.open);

  return (
    <div data-testid="view-calendar">
      <div className="cal-legend">
        <span className="section-title" style={{ margin: 0 }}>
          시즌 일정
        </span>
        <span className="cal-focus">
          {openWindow ? `${openWindow.kind} 이적시장 열림 (~${openWindow.closesOn})` : "이적시장 닫힘"}
          {" · 훈련은 메인 채팅에서 지시하세요"}
        </span>
      </div>

      {detail && (
        <div className="cal-detail" data-testid="cal-detail">
          <div className="cal-detail-head">
            <b>
              {detail.iso} ({WEEK[detail.dow]})
            </b>
            <button className="ghost-btn" onClick={() => setSelected(null)}>
              닫기
            </button>
          </div>

          {detail.entries.length > 0 && (
            <div className="cal-detail-block">
              <div className="cal-detail-title">📅 이날의 일정</div>
              {detail.entries.map((e) => (
                <div className="cal-detail-sub" key={e.id}>
                  {e.time} · {e.title}
                  {e.detail ? ` — ${e.detail}` : ""}
                  {e.result ? ` · ${e.result}` : ""}
                </div>
              ))}
            </div>
          )}

          {detail.events.length > 0 && (
            <div className="cal-detail-block">
              <div className="cal-detail-title">📋 이날의 기록</div>
              {detail.events.map((e, i) => (
                <div className="cal-detail-line" key={i}>
                  {e}
                </div>
              ))}
            </div>
          )}

          {detail.entries.length === 0 && detail.events.length === 0 && (
            <div className="cal-detail-sub">
              {detail.isPast ? "기록된 일정이 없습니다." : "예정된 일정이 없습니다 — 채팅에서 훈련을 지시하세요."}
            </div>
          )}
        </div>
      )}

      <div className="cal-months">
        {months.map(({ year, month }) => {
          const first = new Date(Date.UTC(year, month, 1));
          const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
          const lead = first.getUTCDay();
          const cells: Array<{ day: number; iso: string } | null> = [];
          for (let i = 0; i < lead; i++) cells.push(null);
          for (let d = 1; d <= daysInMonth; d++) {
            cells.push({ day: d, iso: isoOf(new Date(Date.UTC(year, month, d))) });
          }
          return (
            <div className="cal-month" key={`${year}-${month}`}>
              <div className="cal-month-title">
                {year}년 {month + 1}월
              </div>
              <div className="cal-grid">
                {WEEK.map((w) => (
                  <div className="cal-dow" key={w}>
                    {w}
                  </div>
                ))}
                {cells.map((cell, i) => {
                  if (!cell) return <div className="cal-cell empty" key={i} />;
                  const mt = matchOf(cell.iso);
                  const win = mt?.win ?? null;
                  const isToday = cell.iso === calendar.today;
                  const hasEvents = (calendar.events[cell.iso]?.length ?? 0) > 0;
                  const trainDot = trainingOf(cell.iso).some((e) => e.status === "scheduled");
                  const wd = windowOf(cell.iso);
                  return (
                    <button
                      className={`cal-cell${isToday ? " today" : ""}${selected === cell.iso ? " selected" : ""}`}
                      key={i}
                      onClick={() => setSelected(cell.iso)}
                      data-testid={mt ? `cal-fixture-${cell.iso}` : `cal-day-${cell.iso}`}
                    >
                      <div className="cal-day">{cell.day}</div>
                      {mt && (
                        <div className={`cal-fx ${win ? `r-${win}` : mt.isNext ? "next" : "sched"}`}>
                          <span className="cal-fx-opp">{mt.title.replace(/^R\d+\s/, "")}</span>
                          <span className="cal-fx-res">{mt.result ?? (mt.isNext ? "다음" : "예정")}</span>
                        </div>
                      )}
                      {wd && <div className="cal-window" title={wd.title}>🔁</div>}
                      {trainDot && <div className="cal-train" title="예정 훈련" />}
                      {hasEvents && <div className="cal-event-dot" title="기록 있음" />}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 재정 (요약 카드 + 실시간 활동 + 월간 보고서) ─────────────
type FinanceMonth = OfficeViews["finance"]["current"];

const signed = (v: number) => `${v >= 0 ? "+" : "−"}${money(Math.abs(v))}`;

/** 한 달 — 마감된 보고서와 진행 중인 이번 달이 같은 모양을 쓴다 */
function FinanceMonthCard({ month }: { month: FinanceMonth }) {
  return (
    <div className="fin-month" data-testid={`fin-month-${month.month}`}>
      <div className="fin-month-head">
        <b>
          {month.month}
          {!month.closed && <span className="fin-tag">진행 중</span>}
        </b>
        <span className={month.cashNet >= 0 ? "fin-net plus" : "fin-net minus"}>
          {signed(month.cashNet)}
        </span>
      </div>
      <div className="fin-meta">
        장부 손익 {signed(month.pnlNet)} · 급여 비중{" "}
        <b className={month.wageRatio >= 0.75 ? "danger" : month.wageRatio >= 0.65 ? "warn" : ""}>
          {Math.round(month.wageRatio * 100)}%
        </b>
      </div>
      <div className="fin-cols">
        <div className="fin-col">
          <div className="fin-col-title income">수입 {money(month.incomeTotal)}</div>
          {month.income.map((item) => (
            <div className="fin-line" key={item.category}>
              <span>{item.label}</span>
              <span>{money(item.amount)}</span>
            </div>
          ))}
          {month.income.length === 0 && <div className="fin-line muted">수입 없음</div>}
        </div>
        <div className="fin-col">
          <div className="fin-col-title expense">지출 {money(month.expenseTotal)}</div>
          {month.expense.map((item) => (
            <div className="fin-line" key={item.category}>
              <span>
                {item.label}
                {item.category === "amortisation" && <span className="fin-tag">장부</span>}
              </span>
              <span>{money(item.amount)}</span>
            </div>
          ))}
          {month.expense.length === 0 && <div className="fin-line muted">지출 없음</div>}
        </div>
      </div>
      {month.notes.map((note) => (
        <div className="fin-note" key={note}>
          {note}
        </div>
      ))}
    </div>
  );
}

export function FinanceView({ finance }: { finance: OfficeViews["finance"] }) {
  return (
    <div data-testid="view-finance">
      <div className="finance-cards">
        <div className="finance-card">
          <div className="label">구단 잔고</div>
          <div className="value">{money(finance.balance)}</div>
        </div>
        <div className="finance-card">
          <div className="label">주급 총액 (주)</div>
          <div className="value">{money(finance.weeklyWages)}</div>
        </div>
        <div className="finance-card">
          <div className="label">이적 예산</div>
          <div className="value">
            {money(finance.transferBudget)}
            {finance.budgetFrozen && <span className="fin-tag danger">동결</span>}
          </div>
        </div>
        <div className="finance-card">
          <div className="label">급여 비중 (시즌)</div>
          <div className="value">
            {Math.round(finance.wageRatio * 100)}%
            <span className="fin-sub">
              {finance.stadium.name} {finance.stadium.capacity.toLocaleString("en-US")}석
            </span>
          </div>
        </div>
      </div>

      {finance.psr && (
        <div className="fin-psr" data-testid="fin-psr">
          <span>PSR (3시즌 누적 손익)</span>
          <span>
            {signed(finance.psr.rolling3Season)} · 여유{" "}
            <b className={finance.psr.headroom < 0 ? "danger" : ""}>
              {money(finance.psr.headroom)}
            </b>
          </span>
        </div>
      )}
      <div className="fin-board">보드 평가: {finance.boardExpectation}</div>

      <div className="section-title">재정 활동 (실시간)</div>
      {finance.feed.length === 0 && (
        <div className="empty">아직 기록이 없습니다 — 시간이 흐르면 주급·중계권·입장 수입이 쌓입니다.</div>
      )}
      {finance.feed.length > 0 && (
        <div className="fin-feed" data-testid="fin-feed">
          {finance.feed.map((entry) => (
            <div className="fin-feed-row" key={entry.id}>
              <span className="date">{entry.date.slice(5)}</span>
              <span className="cat">{entry.categoryLabel}</span>
              <span className="label">{entry.label}</span>
              <span className={entry.kind === "income" ? "amt plus" : "amt minus"}>
                {entry.kind === "income" ? "+" : "−"}
                {money(entry.amount)}
                {entry.noncash && <span className="fin-tag">장부</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="section-title">월간 재정 보고서</div>
      <FinanceMonthCard month={finance.current} />
      {finance.reports.map((month) => (
        <FinanceMonthCard month={month} key={month.month} />
      ))}
    </div>
  );
}

// ── 대회 — 대회별 탭 · 순위표 · 라운드별 일정 ──────────────
type Competition = OfficeViews["competitions"]["list"][number];

/** 순위표 — 리그는 그대로, 대항전은 통과 경계선을 긋는다 */
function StandingsTable({
  competition,
  teamName,
}: {
  competition: Competition;
  teamName: string;
}) {
  const europe = competition.europe;
  return (
    <table data-testid={competition.kind === "cup" ? "europe-standings" : "standings"}>
      <thead>
        <tr>
          <th>#</th>
          <th>팀</th>
          <th>경기</th>
          <th>승</th>
          <th>무</th>
          <th>패</th>
          <th>득실</th>
          <th>승점</th>
        </tr>
      </thead>
      <tbody>
        {competition.standings.map((row, i) => (
          <tr
            key={row.teamId}
            className={[
              row.name === teamName ? "me" : "",
              europe && (i + 1 === europe.directSlots || i + 1 === europe.playoffCutoff)
                ? "cut"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <td>{i + 1}</td>
            <td className="team-cell">{row.name}</td>
            <td>{row.played}</td>
            <td>{row.wins}</td>
            <td>{row.draws}</td>
            <td>{row.losses}</td>
            <td>{row.goalDiff > 0 ? `+${row.goalDiff}` : row.goalDiff}</td>
            <td>
              <b>{row.points}</b>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 라운드 하나의 경기 목록 — 라운드 선택기로 오간다 */
function RoundFixtures({ competition }: { competition: Competition }) {
  const rounds = competition.rounds;
  const currentIndex = Math.max(
    0,
    rounds.findIndex((r) => r.current),
  );
  const [picked, setPicked] = useState<number | null>(null);
  // 대회를 바꾸면 선택을 놓아 그 대회의 현재 라운드로 돌아간다
  const [ownerId, setOwnerId] = useState(competition.id);
  if (ownerId !== competition.id) {
    setOwnerId(competition.id);
    setPicked(null);
  }
  const index = Math.min(picked ?? currentIndex, rounds.length - 1);
  const round = rounds[index];
  if (!round) return <div className="empty">아직 편성된 일정이 없습니다</div>;

  return (
    <div data-testid="round-fixtures">
      <div className="round-nav">
        <button
          onClick={() => setPicked(Math.max(0, index - 1))}
          disabled={index === 0}
          aria-label="이전 라운드"
        >
          ◀
        </button>
        <select
          value={index}
          onChange={(e) => setPicked(Number(e.target.value))}
          data-testid="round-select"
        >
          {rounds.map((r, i) => (
            <option value={i} key={r.key}>
              {r.label}
              {r.current ? " (현재)" : ""}
            </option>
          ))}
        </select>
        <button
          onClick={() => setPicked(Math.min(rounds.length - 1, index + 1))}
          disabled={index === rounds.length - 1}
          aria-label="다음 라운드"
        >
          ▶
        </button>
      </div>
      <div className="fixture-list">
        {round.matches.map((m) => (
          <div className={`fixture${m.ours ? " ours" : ""}`} key={m.id}>
            <span className="when">
              {m.date.slice(5)} <span className="hide-sm">{m.time}</span>
            </span>
            <span className="side home">{m.homeName}</span>
            <span className={`mid${m.score ? " played" : ""}`}>
              {m.score ?? "vs"}
              {m.win && <b className={`wdl ${m.win}`}>{m.win}</b>}
            </span>
            <span className="side away">{m.awayName}</span>
            {m.neutral && <span className="fin-tag">중립</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CompetitionsView({
  competitions,
  teamName,
}: {
  competitions: OfficeViews["competitions"];
  teamName: string;
}) {
  const list = competitions.list;
  const [activeId, setActiveId] = useState(list[0]?.id ?? "");
  const active = list.find((c) => c.id === activeId) ?? list[0];

  return (
    <div data-testid="view-competitions">
      {competitions.next && (
        <div className="manager-card">
          <div className="bg">다음 경기</div>
          <div>{competitions.next}</div>
        </div>
      )}

      {list.length > 1 && (
        <div className="comp-tabs" data-testid="comp-tabs">
          {list.map((c) => (
            <button
              key={c.id}
              className={active?.id === c.id ? "active" : ""}
              onClick={() => setActiveId(c.id)}
              data-testid={`comp-tab-${c.id}`}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {!active && <div className="empty">참가 중인 대회가 없습니다</div>}
      {active && (
        <>
          <div className="comp-head">
            <b>{active.name}</b>
            <span>
              {active.userPosition > 0
                ? `${active.kind === "cup" ? "리그 페이즈 " : ""}${active.userPosition}위`
                : "순위 없음"}
              {active.next ? ` · 다음 ${active.next}` : " · 남은 경기 없음"}
            </span>
          </div>

          <div className="section-title">순위</div>
          <StandingsTable competition={active} teamName={teamName} />
          {active.europe && (
            <div className="euro-legend">
              1~{active.europe.directSlots}위 본선 직행 · {active.europe.directSlots + 1}~
              {active.europe.playoffCutoff}위 플레이오프
            </div>
          )}

          {active.europe && active.europe.bracket.length > 0 && (
            <BracketSection bracket={active.europe.bracket} />
          )}

          <div className="section-title">일정</div>
          <RoundFixtures competition={active} />

          {competitions.recentResults.length > 0 && (
            <>
              <div className="section-title">우리 팀 최근 결과 (전 대회)</div>
              {competitions.recentResults.map((r, i) => (
                <div key={i} style={{ fontSize: 12.5, padding: "2px 0" }}>
                  {r}
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** 녹아웃 브래킷 — 단계별 대진 (2차전 합계는 엔진이 계산해 넘긴다) */
function BracketSection({
  bracket,
}: {
  bracket: NonNullable<Competition["europe"]>["bracket"];
}) {
  return (
    <div data-testid="europe">
      {bracket.map((stage) => (
        <div key={stage.stage} className="euro-stage">
          <div className="section-title">{stage.label}</div>
          {stage.ties.map((tie, i) => (
            <div
              key={i}
              className={`euro-tie${tie.ours ? " ours" : ""}`}
              data-testid={tie.ours ? "euro-tie-ours" : undefined}
            >
              <span className="euro-teams">
                {tie.home} vs {tie.away}
              </span>
              <span className="euro-score">
                {tie.score ?? "예정"}
                {tie.won === true && " ✓"}
                {tie.won === false && " ✕"}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── 커리어 ──────────────────────────────────────────────
export function CareerView({
  squad,
  career,
}: {
  squad: OfficeViews["squad"];
  career: OfficeViews["career"];
}) {
  return (
    <div data-testid="view-career">
      <div className="manager-card">
        <h3>{squad.manager.name} 감독</h3>
        <div className="bg">{squad.manager.background}</div>
        <AttrBar label="리더십" value={squad.manager.attributes.leadership ?? 0} />
        <AttrBar label="전술" value={squad.manager.attributes.tactics ?? 0} />
        <AttrBar label="협상" value={squad.manager.attributes.negotiation ?? 0} />
        <AttrBar label="미디어" value={squad.manager.attributes.media ?? 0} />
        <div className="section-title">
          평판 — 보드 {squad.manager.reputation.board} · 언론 {squad.manager.reputation.media} · 선수단{" "}
          {squad.manager.reputation.squad}
        </div>
      </div>

      <div className="section-title">🏆 트로피 보관함</div>
      <div className="trophy-list">
        {career.trophies.length === 0 && (
          <div className="empty">아직 트로피가 없다 — 역사는 지금부터다</div>
        )}
        {career.trophies.map((t, i) => (
          <div className="trophy" key={i}>
            🏆 {t.competition} — 시즌 {t.season} ({t.teamName})
          </div>
        ))}
      </div>

      <div className="section-title">업적</div>
      <div className="trophy-list">
        {career.achievements.length === 0 && <div className="empty">달성한 업적이 없다</div>}
        {career.achievements.map((a, i) => (
          <div className="achv" key={i}>
            <div>{a.name}</div>
            <div className="desc">
              시즌 {a.season} — {a.description}
            </div>
          </div>
        ))}
      </div>

      <div className="section-title">시즌 기록</div>
      {career.seasons.length === 0 ? (
        <div className="empty">첫 시즌 진행 중</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>시즌</th>
              <th>팀</th>
              <th>순위</th>
              <th>전적</th>
            </tr>
          </thead>
          <tbody>
            {career.seasons.map((s) => (
              <tr key={s.season}>
                <td>{s.season}</td>
                <td>{s.teamName}</td>
                <td>{s.position}위</td>
                <td>{s.record}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
