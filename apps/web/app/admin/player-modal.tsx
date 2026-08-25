"use client";

import { useState } from "react";
import {
  ASSOCIATIONS,
  AXIS_GROUPS,
  AXIS_GROUP_KO,
  AXIS_KO,
  POSITION_CODES,
  type AttributeAxis,
} from "@story-fm/domain";
import { Modal } from "./modal";
import {
  ATTRS,
  clampAttr,
  type CatalogPosition,
  type CatalogResponse,
  type PlayerRow,
  type TeamGroup,
} from "./types";

/**
 * 선수 편집 창 — 목록의 요약 행에서 열린다. 추가와 편집이 같은 창을 쓴다.
 *
 * 편집 모드에선 **주 포지션을 따로 받지 않는다**: 포지션 목록의 `선호` 표시가
 * 곧 주 포지션이라, 두 칸을 나란히 두면 서버에서 한쪽이 다른 쪽을 덮어쓴다.
 * 추가 모드에선 목록이 아직 없으므로 주 포지션 하나만 받고 서버가 파생시킨다.
 *
 * 한 줄이 묻는 것은 셋이고 서로 다른 질문이다 (player.md §4·§8) — 어느 자리인가 ·
 * 그 자리가 **본업(선호)인가** · 그 자리를 **얼마나 아는가(적응도)**. 선호는 여럿일
 * 수 있어 체크박스고, 적응도는 정도의 문제라 막대와 숫자를 함께 둔다.
 *
 * 소속 팀은 두 모드에 다 있다 — 방출도 무소속 팀으로 옮기는 것이라 별도 손잡이가
 * 없다. 떠나는 팀의 라인업 하한(인원·GK)은 엔진이 보므로, 거절 메시지를 이 창
 * 안에 그대로 띄우고 창을 닫지 않는다 (고친 값을 잃지 않게).
 */

const AXIS_GROUP_KEYS = Object.keys(AXIS_GROUPS) as Array<keyof typeof AXIS_GROUPS>;
const NEW_BIRTHDATE = "2004-01-01";
const MAX_WAGE = 2_000_000;

type Mode = "create" | "edit";

/** 협회 셀렉트의 줄 — 코드 순으로 세운다 (표기순은 한글 정렬이라 코드와 어긋난다) */
const ASSOCIATION_OPTIONS: [string, string][] = Object.entries(ASSOCIATIONS)
  .map(([code, a]): [string, string] => [code, a.ko])
  .sort((x, y) => x[0].localeCompare(y[0]));

export function PlayerModal({
  mode,
  player,
  teamGroups,
  defaultTeamId,
  ageRef,
  onSaved,
  onClose,
}: {
  mode: Mode;
  /** 편집 모드에서만 있다 */
  player?: PlayerRow;
  /** 리그로 묶은 팀 — 셀렉트의 `optgroup` 순서 그대로다 */
  teamGroups: TeamGroup[];
  defaultTeamId: string;
  ageRef: string;
  onSaved: (data: CatalogResponse) => void;
  onClose: () => void;
}) {
  const [teamId, setTeamId] = useState(player?.teamId ?? defaultTeamId);
  const [nameKo, setNameKo] = useState(player?.nameKo ?? "");
  const [nameEn, setNameEn] = useState(player?.nameEn ?? "");
  const [birthdate, setBirthdate] = useState(player?.birthdate ?? NEW_BIRTHDATE);
  const [mainPosition, setMainPosition] = useState(player?.position ?? "CM");
  const [positions, setPositions] = useState<CatalogPosition[]>(
    player ? player.positions.map((p) => ({ ...p })) : [],
  );
  // 축은 전수다 — `ATTRS`로 지은 표라 빠진 축이 없고, 그렇게 적어야 칸마다 되묻지 않는다
  const [axes, setAxes] = useState<Record<AttributeAxis, number>>(
    Object.fromEntries(ATTRS.map((a) => [a, player ? player[a] : 60])) as Record<
      AttributeAxis,
      number
    >,
  );
  const [nationality, setNationality] = useState(player?.nationality ?? "");
  const [secondNationality, setSecondNationality] = useState(player?.secondNationality ?? "");
  const [potential, setPotential] = useState(player?.potential ?? 70);
  // 빈 칸이 곧 "실측 없음"이다 — 0으로 출발하면 두 뜻이 한 값에 겹친다
  const [wage, setWage] = useState<number | "">(player?.weeklyWage ?? "");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 셀렉트를 따라간다 — 머리줄이 지금 고른 소속을 말해야 저장 전에 어디로 가는지 보인다.
  // 리그까지 말하는 이유: 셀렉트가 리그로 묶여 있어도 접힌 뒤엔 팀 이름만 남는다.
  const picked = teamGroups
    .flatMap((g) => g.teams.map((t) => ({ ...t, leagueName: g.leagueName })))
    .find((t) => t.id === teamId);
  const teamName = picked?.name ?? player?.teamName ?? "";
  const where = picked ? `${picked.leagueName} · ${picked.name}` : teamName;

  function setPos(index: number, patch: Partial<CatalogPosition>) {
    setPositions((cur) => cur.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }
  function addPos() {
    const used = new Set(positions.map((p) => p.position));
    const next = POSITION_CODES.find((c) => !used.has(c));
    // 남은 코드가 없으면 더하지 않는다 — 중복 포지션은 저장에서 거절당한다
    if (next === undefined) return;
    setPositions((cur) => [
      ...cur,
      { position: next, proficiency: 70, isNatural: cur.length === 0 },
    ]);
  }

  /** 저장 전 검증 — 서버가 거절할 조합을 여기서 먼저 잡는다 */
  function validate(): string | null {
    if (!nameKo.trim()) return "이름 없음";
    if (!teamId) return "팀을 고르세요";
    if (mode === "edit") {
      if (positions.length === 0) return "포지션이 최소 하나 필요합니다";
      if (!positions.some((p) => p.isNatural)) return "선호 포지션 0개 — 최소 1개";
      const codes = positions.map((p) => p.position);
      if (new Set(codes).size !== codes.length) return "같은 포지션이 두 번 들어 있습니다";
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate))
      return "생년월일 형식(YYYY-MM-DD)이 올바르지 않습니다";
    return null;
  }

  async function save() {
    const bad = validate();
    if (bad) {
      setFormError(bad);
      return;
    }
    setFormError(null);
    setSaving(true);
    const numbers = {
      ...Object.fromEntries(ATTRS.map((a) => [a, clampAttr(axes[a])])),
      potential: clampAttr(potential),
    };
    /**
     * 주급은 실측이고 **없는 것이 기본**이다 (game-state.md §2). 빈 칸을 0으로
     * 실으면 새 게임 계약이 £0/주로 굳으므로, 비어 있으면 값을 아예 싣지 않는다.
     * 원래 실측이 있던 선수를 비운 것만 `null` — 실측을 지워 모델 추정으로 돌린다.
     */
    const weeklyWage = wage === "" ? null : Math.min(MAX_WAGE, Math.max(0, Math.round(wage) || 0));
    const wagePatch = weeklyWage === null && player?.weeklyWage === undefined ? {} : { weeklyWage };
    try {
      const res =
        mode === "create"
          ? await fetch("/api/admin/catalog", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                teamId,
                nameKo: nameKo.trim(),
                nameEn: nameEn.trim() || undefined,
                birthdate,
                position: mainPosition,
                ...(nationality === "" ? {} : { nationality }),
                ...(secondNationality === "" ? {} : { secondNationality }),
                ...numbers,
                ...(weeklyWage === null ? {} : { weeklyWage }),
              }),
            })
          : await fetch(`/api/admin/catalog/player/${player!.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                // 지금 소속과 같으면 서버가 이동을 건너뛴다 — 늘 실어 보내도 안전하다
                teamId,
                nameKo: nameKo.trim(),
                nameEn: nameEn.trim() || undefined,
                birthdate,
                // 빈 칸은 "지운다"가 아니라 "손대지 않는다"다 — 첫째 국적은 비울 수
                // 없는 값이라(카탈로그가 클럽 협회로 채운다) 빈 채로 실어 보내지 않는다.
                // 둘째는 빈 문자열이 곧 지우기다 (world/admin.ts)
                ...(nationality === "" ? {} : { nationality }),
                secondNationality,
                positions: positions.map((p) => ({
                  position: p.position,
                  proficiency: clampAttr(p.proficiency),
                  isNatural: p.isNatural,
                })),
                ...numbers,
                ...wagePatch,
              }),
            });
      const data: CatalogResponse = await res.json();
      if (!res.ok) throw new Error(data.error ?? "요청 실패");
      onSaved(data);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!player) return;
    const ok = window.confirm(
      `카탈로그에서 ${player.teamName}의 ${player.nameKo}을(를) 삭제할까요?\n(새 게임부터 반영됩니다)`,
    );
    if (!ok) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/catalog/player/${player.id}`, { method: "DELETE" });
      const data: CatalogResponse = await res.json();
      if (!res.ok) throw new Error(data.error ?? "삭제 실패");
      onSaved(data);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      wide
      testId="player-modal"
      title={mode === "create" ? "새 선수" : `${nameKo || player?.nameKo} 편집`}
      subtitle={
        mode === "create"
          ? "카탈로그에 추가합니다 — 새로 시작하는 게임부터 반영됩니다"
          : `${where} · OVR ${player?.overall} · ${player?.age}세${ageRef ? ` (${ageRef} 기준)` : ""}`
      }
      onClose={onClose}
      footer={
        <>
          <button
            className="primary-btn"
            onClick={() => void save()}
            disabled={saving || !nameKo.trim()}
            data-testid="player-modal-save"
          >
            {saving ? "저장 중…" : mode === "create" ? "카탈로그에 추가" : "저장"}
          </button>
          <button className="ghost-btn" onClick={onClose} disabled={saving}>
            취소
          </button>
          {mode === "edit" && (
            <button
              className="ghost-btn admin-modal-danger"
              onClick={() => void remove()}
              disabled={saving}
              data-testid="player-modal-delete"
            >
              삭제
            </button>
          )}
        </>
      }
    >
      {formError && (
        <div className="admin-msg err" data-testid="player-modal-err">
          {formError}
        </div>
      )}

      <div className="admin-fields">
        <label className="admin-field grow">
          이름 (한글)
          <input
            value={nameKo}
            onChange={(e) => setNameKo(e.target.value)}
            data-testid="player-modal-name"
          />
        </label>
        <label className="admin-field grow">
          로마자
          <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
        </label>
        <label className="admin-field">
          생년월일
          <input
            type="date"
            value={birthdate}
            onChange={(e) => setBirthdate(e.target.value)}
            data-testid="player-modal-birthdate"
          />
        </label>
        <label className="admin-field">
          국적
          <select
            value={nationality}
            onChange={(e) => setNationality(e.target.value)}
            data-testid="player-modal-nationality"
          >
            <option value="">— 클럽 협회로 —</option>
            {ASSOCIATION_OPTIONS.map(([code, ko]) => (
              <option key={code} value={code}>
                {code} · {ko}
              </option>
            ))}
          </select>
        </label>
        <label className="admin-field">
          둘째 국적
          <select
            value={secondNationality}
            onChange={(e) => setSecondNationality(e.target.value)}
            data-testid="player-modal-second-nationality"
          >
            <option value="">— 없음 —</option>
            {ASSOCIATION_OPTIONS.map(([code, ko]) => (
              <option key={code} value={code}>
                {code} · {ko}
              </option>
            ))}
          </select>
        </label>
        <label className="admin-field">
          소속 팀
          <select
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            data-testid="player-modal-team"
          >
            {teamGroups.map((g) => (
              <optgroup key={g.leagueId} label={g.leagueName}>
                {g.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {mode === "create" && (
          <label className="admin-field">
            주 포지션
            <select
              value={mainPosition}
              onChange={(e) => setMainPosition(e.target.value)}
              data-testid="player-modal-position"
            >
              {POSITION_CODES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {mode === "edit" ? (
        <section>
          <div className="admin-section-head">
            <b className="admin-section-title">포지션</b>
            <button className="mini-btn" onClick={addPos} data-testid="player-modal-pos-add">
              + 포지션
            </button>
          </div>
          <div className="admin-pos-rows">
            <div className="admin-pos-row admin-pos-head">
              <span>자리</span>
              <span>선호</span>
              <span>적응도</span>
              <span />
            </div>
            {positions.map((p, i) => (
              <div
                className={`admin-pos-row${p.isNatural ? " nat" : ""}`}
                key={`${p.position}-${i}`}
                data-testid={`player-modal-pos-${i}`}
              >
                <select
                  value={p.position}
                  onChange={(e) => setPos(i, { position: e.target.value })}
                  aria-label={`${p.position} 자리`}
                >
                  {POSITION_CODES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <input
                  type="checkbox"
                  checked={p.isNatural}
                  onChange={(e) => setPos(i, { isNatural: e.target.checked })}
                  aria-label={`${p.position} 선호 포지션`}
                  data-testid={`player-modal-pos-${i}-natural`}
                />
                {/* 막대가 값의 크기를, 숫자 칸이 정확한 값을 맡는다 — 둘 다 같은 state */}
                <span className="admin-pos-prof">
                  <input
                    type="range"
                    min={1}
                    max={99}
                    value={p.proficiency}
                    onChange={(e) => setPos(i, { proficiency: Number(e.target.value) })}
                    aria-label={`${p.position} 적응도`}
                  />
                  <input
                    className="ai num"
                    type="number"
                    min={1}
                    max={99}
                    value={p.proficiency}
                    onChange={(e) => setPos(i, { proficiency: Number(e.target.value) })}
                    aria-label={`${p.position} 적응도 값`}
                  />
                </span>
                <button
                  className="mini-btn del"
                  onClick={() => setPositions((cur) => cur.filter((_, j) => j !== i))}
                  aria-label={`${p.position} 삭제`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : (
        /* 새 선수는 아직 고칠 목록이 없다 — 무엇이 그 자리를 채우는지만 적는다 */
        <section>
          <div className="admin-section-head">
            <b className="admin-section-title">포지션</b>
            <span className="admin-section-note">주 포지션에서 파생</span>
          </div>
        </section>
      )}

      <section>
        <div className="admin-section-head">
          <b className="admin-section-title">능력치 16축</b>
          <span className="admin-section-note">1–99 · OVR은 파생값이라 저장하지 않습니다</span>
        </div>
        <div className="admin-axis-groups">
          {AXIS_GROUP_KEYS.map((group) => (
            <div className="admin-axis-group" key={group}>
              <span className="admin-axis-group-name">{AXIS_GROUP_KO[group]}</span>
              <div className="admin-axes">
                {AXIS_GROUPS[group].map((axis: AttributeAxis) => (
                  <label className="admin-axis" key={axis}>
                    <span>{AXIS_KO[axis]}</span>
                    <input
                      className="ai num"
                      type="number"
                      min={1}
                      max={99}
                      value={axes[axis]}
                      onChange={(e) => setAxes((s) => ({ ...s, [axis]: Number(e.target.value) }))}
                      data-testid={`player-modal-axis-${axis}`}
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="admin-fields">
        <label className="admin-field">
          POT (잠재치)
          <input
            className="ai num"
            type="number"
            min={1}
            max={99}
            value={potential}
            onChange={(e) => setPotential(Number(e.target.value))}
            data-testid="player-modal-potential"
          />
        </label>
        <label className="admin-field">
          주급 (£/주)
          <input
            className="ai num wage"
            type="number"
            min={0}
            max={MAX_WAGE}
            step={1000}
            value={wage}
            placeholder="모델 추정"
            onChange={(e) => setWage(e.target.value === "" ? "" : Number(e.target.value))}
            data-testid="player-modal-wage"
          />
        </label>
      </div>
    </Modal>
  );
}
