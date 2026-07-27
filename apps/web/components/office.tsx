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

// ── 스쿼드 (읽기 + 전술판 라인업 편집) ─────────────────────
type SquadRow = OfficeViews["squad"]["players"][number];
type Selection = { kind: "slot"; index: number } | { kind: "bench"; id: string } | null;

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

export function SquadView({
  game,
  onUpdate,
  onGoToChat,
}: {
  game: GamePayload;
  onUpdate: (payload: GamePayload) => void;
  onGoToChat: () => void;
}) {
  const players = game.views.squad.players;
  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const [editing, setEditing] = useState(false);
  const [formation, setFormation] = useState(game.views.squad.formation);
  const [slots, setSlots] = useState<Array<string | null>>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [benchSet, setBenchSet] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const MAX_BENCH = 9;
  const layout = FORMATION_LAYOUTS[formation] ?? FORMATION_LAYOUTS["4-3-3"]!;
  const slotSet = new Set(slots.filter(Boolean) as string[]);
  const benchPlayers = players.filter((p) => !slotSet.has(p.id));
  const benchDesignated = benchPlayers.filter((p) => benchSet.has(p.id));

  function startEdit() {
    const fm = FORMATIONS.includes(game.views.squad.formation)
      ? game.views.squad.formation
      : "4-3-3";
    setFormation(fm);
    setSlots(
      assignSlots(FORMATION_LAYOUTS[fm]!, players.filter((p) => p.role === "선발")),
    );
    // 현재 매치데이 벤치(역할=벤치)를 초기 선택으로
    setBenchSet(new Set(players.filter((p) => p.role === "벤치").map((p) => p.id)));
    setSelection(null);
    setSaveError(null);
    setEditing(true);
  }

  /** 비선발 선수를 매치데이 벤치(최대 9)로 지정/해제 — 나머지는 예비 스쿼드 */
  function toggleBench(id: string) {
    setBenchSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        const count = benchPlayers.filter((p) => next.has(p.id)).length;
        if (count >= MAX_BENCH) return prev; // 벤치 정원 초과 방지
        next.add(id);
      }
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

  /** 선택-스왑: 슬롯↔슬롯은 자리 교환, 슬롯↔벤치는 선수 교체 */
  function applySwap(a: Selection, b: Selection) {
    if (!a || !b) return;
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
    setSelection(null);
  }

  function clickSlot(index: number) {
    const here: Selection = { kind: "slot", index };
    if (!selection) return setSelection(here);
    if (selection.kind === "slot" && selection.index === index) return setSelection(null);
    applySwap(selection, here);
  }

  function clickBench(id: string) {
    const here: Selection = { kind: "bench", id };
    if (!selection) return setSelection(here);
    if (selection.kind === "bench") return setSelection(selection.id === id ? null : here);
    applySwap(selection, here);
  }

  const gkSlotIdx = layout.findIndex((s) => s.code === "GK");
  const gkOccupant = gkSlotIdx >= 0 ? byId.get(slots[gkSlotIdx] ?? "") : undefined;
  const gkWarning = gkOccupant && gkOccupant.positionGroup !== "GK";
  const unavailableInXI = slots
    .filter((id): id is string => id !== null)
    .map((id) => byId.get(id))
    .filter((p): p is SquadRow => p !== undefined && !p.available);

  async function save() {
    setSaving(true);
    setSaveError(null);
    // v6: 선발은 {playerId, position} 배치로 보낸다 (전술판 슬롯 = 배치 포지션)
    const starting = slots
      .map((id, i) => (id ? { playerId: id, position: layout[i]!.code } : null))
      .filter((x): x is { playerId: string; position: string } => x !== null);
    // 매치데이 벤치 = 유저가 지정한 선수(최대 9). 나머지 비선발은 예비 스쿼드
    const bench = benchDesignated.map((p) => ({ playerId: p.id }));
    try {
      const res = await fetch(`/api/games/${game.id}/lineup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starting, bench, formation }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "저장 실패");
      onUpdate(data);
      setEditing(false);
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
        <div className="section-title" style={{ margin: 0 }}>
          선발 · 포메이션 {editing ? formation : game.views.squad.formation}
        </div>
        {game.views.squad.editable && !editing && (
          <button className="ghost-btn" onClick={startEdit} data-testid="edit-lineup">
            전술판 열기
          </button>
        )}
        {!game.views.squad.editable && (
          <button className="ghost-btn" onClick={onGoToChat}>
            경기 중 — 채팅으로
          </button>
        )}
      </div>

      {editing ? (
        <div className="lineup-editor" data-testid="lineup-editor">
          <div className="board-toolbar">
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
                {saving ? "저장 중…" : "라인업 저장"}
              </button>
              <button className="ghost-btn" onClick={() => setEditing(false)} disabled={saving}>
                취소
              </button>
            </div>
          </div>

          {(gkWarning || unavailableInXI.length > 0 || saveError) && (
            <div className="lineup-status warn" data-testid="lineup-status">
              {gkWarning && <div>⚠ GK 슬롯에 필드 플레이어 — 저장하면 그 선수가 골키퍼가 됩니다.</div>}
              {unavailableInXI.length > 0 && (
                <div>
                  ⚠ 선발 불가(부상·정지): {unavailableInXI.map((p) => p.name).join(", ")} — 교체하세요.
                </div>
              )}
              {saveError && <div data-testid="lineup-error">{saveError}</div>}
            </div>
          )}

          <div className="pitch-board" data-testid="pitch-board">
            <div className="pitch-lines" />
            {layout.map((slot, i) => {
              const p = byId.get(slots[i] ?? "");
              const selected = selection?.kind === "slot" && selection.index === i;
              return (
                <button
                  key={i}
                  className={`pitch-slot ${chipClass(p, selected)}`}
                  style={{ left: `${slot.x}%`, top: `${slot.y}%` }}
                  onClick={() => clickSlot(i)}
                  draggable
                  onDragStart={(e) =>
                    e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "slot", index: i }))
                  }
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    try {
                      const from = JSON.parse(e.dataTransfer.getData("text/plain")) as Selection;
                      applySwap(from, { kind: "slot", index: i });
                    } catch {
                      /* 무시 */
                    }
                  }}
                  data-testid={`slot-${i}`}
                >
                  <span className="slot-pos">{slot.code}</span>
                  <span className="slot-name">{p?.name ?? "—"}</span>
                  <span className="slot-ovr">{p?.overall ?? ""}</span>
                </button>
              );
            })}
          </div>

          <div className="section-title" data-testid="bench-count">
            벤치 {benchDesignated.length}/{MAX_BENCH} · 예비 {benchPlayers.length - benchDesignated.length}
            <span className="hint" style={{ fontWeight: 400 }}> — 탭해 선발과 교체 · 배지로 벤치/예비 지정</span>
          </div>
          <div className="bench-row" onDragOver={(e) => e.preventDefault()}>
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
                  draggable
                  onDragStart={(e) =>
                    e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "bench", id: p.id }))
                  }
                  data-testid={`bench-${p.id}`}
                >
                  <span className="slot-pos">{p.position}</span>
                  <span className="slot-name">{p.name}</span>
                  <span className="slot-ovr">{p.overall}</span>
                  {!p.available && (
                    <span className="badge warn">
                      {p.injury ? `부상(${p.injury.bodyPart})` : `정지 ${p.suspended}경기`}
                    </span>
                  )}
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
          <p className="hint">
            선수를 탭해 선택한 뒤 다른 자리를 탭하면 서로 자리를 바꿉니다(선발 편집). 슬롯의
            포지션이 선수의 새 포지션이 되고, 그룹이 바뀌면 전력 평가(OVR)도 다시 계산됩니다.
            아래쪽 <b>벤치/예비</b> 배지로 매치데이 18인(선발 11 + 벤치 최대 9) 안에 들 선수를
            직접 고를 수 있습니다.
          </p>
        </div>
      ) : (
        <table className="squad-table">
          <thead>
            <tr>
              <th>선수</th>
              <th>포지션</th>
              <th>OVR</th>
              <th className="hide-sm">적응</th>
              <th>폼</th>
              <th>사기</th>
              <th>피로</th>
              <th className="hide-sm">골</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.id} className={p.role === "선발" ? "starter" : ""}>
                <td>
                  {p.isCaptain ? "Ⓒ " : ""}
                  {p.name}
                </td>
                <td>{p.position}</td>
                <td title={p.adaptationDaysLeft > 0 ? "적응 중 — 아직 정확한 수치가 아니다" : undefined}>
                  {p.overall}
                  {p.adaptationDaysLeft > 0 && <span className="est">?</span>}
                </td>
                <td className="hide-sm" title="전술 적응도">{p.familiarity}</td>
                <td>{p.form > 0 ? `+${p.form}` : p.form}</td>
                <td>{p.morale}</td>
                <td>{p.fatigue}</td>
                <td className="hide-sm">{p.seasonGoals}</td>
                <td>
                  {p.injury && <span className="badge warn" title={`${p.injury.severity} · 복귀 예상 ${p.injury.expectedReturn}`}>부상</span>}
                  {p.suspended > 0 && <span className="badge warn">정지 {p.suspended}</span>}
                  {p.suspended > 0 && <span className="badge warn">정지</span>}
                  {p.hasIssue && <span className="badge warn">불만</span>}
                  {p.adaptationDaysLeft > 0 && (
                    <span className="badge" title={`적응 완료까지 약 ${p.adaptationDaysLeft}일 — 수치는 추정치다`}>
                      적응 중
                    </span>
                  )}
                  <span className="badge">{p.role}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
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

// ── 재정 (요약 카드 + 월별 수입/지출) ───────────────────────
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
          <div className="value">{money(finance.transferBudget)}</div>
        </div>
        <div className="finance-card">
          <div className="label">보드 평가</div>
          <div className="value" style={{ fontSize: 13 }}>
            {finance.boardExpectation}
          </div>
        </div>
      </div>

      <div className="section-title">월별 수입·지출</div>
      {finance.months.length === 0 && (
        <div className="empty">아직 정산된 내역이 없습니다 — 시간이 흐르면 주급·중계권·입장 수입이 쌓입니다.</div>
      )}
      {finance.months.map((m) => (
        <div className="fin-month" key={m.month} data-testid={`fin-month-${m.month}`}>
          <div className="fin-month-head">
            <b>{m.month}</b>
            <span className={m.net >= 0 ? "fin-net plus" : "fin-net minus"}>
              {m.net >= 0 ? "+" : "−"}
              {money(Math.abs(m.net))}
            </span>
          </div>
          <div className="fin-cols">
            <div className="fin-col">
              <div className="fin-col-title income">수입 {money(m.incomeTotal)}</div>
              {m.income.map((item) => (
                <div className="fin-line" key={item.label}>
                  <span>{item.label}</span>
                  <span>{money(item.amount)}</span>
                </div>
              ))}
              {m.income.length === 0 && <div className="fin-line muted">수입 없음</div>}
            </div>
            <div className="fin-col">
              <div className="fin-col-title expense">지출 {money(m.expenseTotal)}</div>
              {m.expense.map((item) => (
                <div className="fin-line" key={item.label}>
                  <span>{item.label}</span>
                  <span>{money(item.amount)}</span>
                </div>
              ))}
              {m.expense.length === 0 && <div className="fin-line muted">지출 없음</div>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 순위·최근 결과 ──────────────────────────────────────
export function StandingsView({
  schedule,
  teamName,
}: {
  schedule: OfficeViews["schedule"];
  teamName: string;
}) {
  return (
    <div data-testid="view-schedule">
      {schedule.next && (
        <div className="manager-card">
          <div className="bg">다음 경기</div>
          <div>{schedule.next}</div>
        </div>
      )}
      {schedule.recentResults.length > 0 && (
        <>
          <div className="section-title">최근 결과</div>
          {schedule.recentResults.map((r, i) => (
            <div key={i} style={{ fontSize: 12.5, padding: "2px 0" }}>
              {r}
            </div>
          ))}
        </>
      )}
      <div className="section-title">리그 순위</div>
      <table data-testid="standings">
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
          {schedule.standings.map((row, i) => (
            <tr key={row.teamId} className={row.name === teamName ? "me" : ""}>
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
      {schedule.europe && <EuropeSection europe={schedule.europe} teamName={teamName} />}
    </div>
  );
}

// ── 유럽 대항전 — 리그 페이즈 순위표 + 녹아웃 브래킷 ────
function EuropeSection({
  europe,
  teamName,
}: {
  europe: NonNullable<OfficeViews["schedule"]["europe"]>;
  teamName: string;
}) {
  return (
    <div data-testid="europe">
      <div className="section-title">
        {europe.competition}
        {europe.ourPosition > 0 && ` — 리그 페이즈 ${europe.ourPosition}위`}
      </div>
      <table data-testid="europe-standings">
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
          {europe.standings.map((row, i) => (
            <tr
              key={row.teamId}
              className={[
                row.name === teamName ? "me" : "",
                // 직행 / 플레이오프 경계에 선을 긋는다
                i + 1 === europe.directSlots || i + 1 === europe.playoffCutoff ? "cut" : "",
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
      <div className="euro-legend">
        1~{europe.directSlots}위 본선 직행 · {europe.directSlots + 1}~{europe.playoffCutoff}위
        플레이오프
      </div>
      {europe.bracket.map((stage) => (
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
