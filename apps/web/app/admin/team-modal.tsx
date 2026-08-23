"use client";

import { useState } from "react";
import { FORMATIONS, type Formation } from "@story-fm/domain";
import { Modal } from "./modal";
import {
  GRADES,
  TACTICAL_STYLES,
  TACTICAL_STYLE_KO,
  changedFields,
  numOf,
  type AdminTeamRow,
  type Grade,
  type TacticalStyle,
  type TeamCatalogResponse,
} from "./types";

/**
 * 팀 편집 창 — 목록의 요약 행에서 열린다. 추가와 편집이 같은 창을 쓴다.
 *
 * `leagueId`는 **구조 필드**다 — 옮기면 두 리그의 팀 수가 함께 바뀌어 홀수 리그가
 * 될 수 있다. 그 판정은 엔진의 불변식 검사가 하므로, 실패 메시지를 이 창 안에
 * 그대로 띄우고 창을 닫지 않는다 (고친 값을 잃지 않게).
 */

const MAX_CAPACITY = 200_000;
const ID_RE = /^[a-z0-9-]+$/;

type Mode = "create" | "edit";

/** 서버로 보내는 모양 — 폼 상태를 이 꼴로 접어 놓고 원본과 비교한다 */
interface TeamFields {
  name: string;
  shortName: string;
  leagueId: string;
  tier: Grade;
  formation: Formation | undefined;
  tacticalStyle: TacticalStyle;
  stadium: string;
  capacity: number;
  commercialTier: Grade;
}

export function TeamModal({
  mode,
  team,
  leagues,
  defaultLeagueId,
  onSaved,
  onClose,
}: {
  mode: Mode;
  /** 편집 모드에서만 있다 */
  team?: AdminTeamRow;
  leagues: Array<{ id: string; name: string }>;
  defaultLeagueId: string;
  onSaved: (data: TeamCatalogResponse) => void;
  onClose: () => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState(team?.name ?? "");
  const [shortName, setShortName] = useState(team?.shortName ?? "");
  const [leagueId, setLeagueId] = useState(team?.leagueId ?? defaultLeagueId);
  const [tier, setTier] = useState<Grade>(team?.tier ?? 3);
  const [formation, setFormation] = useState<string>(team?.formation ?? "");
  const [tacticalStyle, setTacticalStyle] = useState<TacticalStyle>(
    team?.tacticalStyle ?? "balanced",
  );
  const [stadium, setStadium] = useState(team?.stadium ?? "");
  const [capacity, setCapacity] = useState(team?.capacity ?? 20_000);
  const [commercialTier, setCommercialTier] = useState<Grade>(team?.commercialTier ?? 3);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const fields: TeamFields = {
    name: name.trim(),
    shortName: shortName.trim(),
    leagueId,
    tier,
    formation: formation === "" ? undefined : (formation as Formation),
    tacticalStyle,
    stadium: stadium.trim(),
    capacity: Math.round(capacity),
    commercialTier,
  };

  /** 저장 전 검증 — 서버가 거절할 조합을 여기서 먼저 잡는다 */
  function validate(): string | null {
    if (mode === "create") {
      if (!ID_RE.test(id.trim())) return "팀 id는 영소문자·숫자·하이픈만 쓸 수 있습니다";
    }
    if (!fields.name) return "팀 이름 없음";
    if (!fields.shortName) return "짧은 이름 없음";
    if (!fields.leagueId) return "소속 리그를 고르세요";
    // 추가할 때 구장 이름은 비워 둘 수 있다 — 엔진이 체급에 맞는 기본 프로필로 채운다
    if (mode === "edit" && !fields.stadium) return "구장 이름 없음";
    if (fields.capacity < 1 || fields.capacity > MAX_CAPACITY) {
      return `수용인원은 1~${MAX_CAPACITY.toLocaleString()} 사이여야 합니다`;
    }
    return null;
  }

  async function save() {
    const bad = validate();
    if (bad) {
      setFormError(bad);
      return;
    }
    let body: Record<string, unknown>;
    if (mode === "create") {
      const { stadium: newStadium, ...rest } = fields;
      body = { id: id.trim(), ...rest, ...(newStadium ? { stadium: newStadium } : {}) };
    } else {
      const patch = changedFields<TeamFields>(
        {
          name: team!.name,
          shortName: team!.shortName,
          leagueId: team!.leagueId,
          tier: team!.tier,
          formation: team!.formation,
          tacticalStyle: team!.tacticalStyle,
          stadium: team!.stadium,
          capacity: team!.capacity,
          commercialTier: team!.commercialTier,
        },
        fields,
      );
      if (Object.keys(patch).length === 0) {
        setFormError("바뀐 값이 없습니다");
        return;
      }
      body = patch;
    }

    setFormError(null);
    setSaving(true);
    try {
      const res = await fetch(
        mode === "create" ? "/api/admin/catalog/team" : `/api/admin/catalog/team/${team!.id}`,
        {
          method: mode === "create" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data: TeamCatalogResponse = await res.json();
      if (!res.ok) throw new Error(data.error ?? "요청 실패");
      onSaved(data);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!team) return;
    const ok = window.confirm(
      `카탈로그에서 ${team.name}을(를) 삭제할까요? 소속 선수 ${team.squadSize}명도 함께 사라집니다.\n(새 게임부터 반영됩니다)`,
    );
    if (!ok) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/catalog/team/${team.id}`, { method: "DELETE" });
      const data: TeamCatalogResponse = await res.json();
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
      testId="team-modal"
      title={mode === "create" ? "새 팀" : `${name || team?.name} 편집`}
      subtitle={
        mode === "create"
          ? "카탈로그에 추가합니다 — 스쿼드는 엔진이 함께 채웁니다"
          : `${team?.leagueName} · 스쿼드 ${team?.squadSize}명`
      }
      onClose={onClose}
      footer={
        <>
          <button
            className="primary-btn"
            onClick={() => void save()}
            disabled={saving}
            data-testid="team-modal-save"
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
              data-testid="team-modal-delete"
            >
              삭제
            </button>
          )}
        </>
      }
    >
      {formError && (
        <div className="admin-msg err" data-testid="team-modal-err">
          {formError}
        </div>
      )}

      <div className="admin-fields">
        {mode === "create" && (
          <label className="admin-field grow">
            팀 id
            <input value={id} onChange={(e) => setId(e.target.value)} data-testid="team-modal-id" />
          </label>
        )}
        <label className="admin-field grow">
          이름
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="team-modal-name"
          />
        </label>
        <label className="admin-field">
          약칭
          <input
            value={shortName}
            onChange={(e) => setShortName(e.target.value)}
            data-testid="team-modal-short"
          />
        </label>
      </div>

      <section>
        <div className="admin-section-head">
          <b className="admin-section-title">소속과 체급</b>
          <span className="admin-section-note">
            리그를 옮기면 두 리그의 팀 수가 함께 바뀝니다 — 홀수가 되면 저장이 막힙니다
          </span>
        </div>
        <div className="admin-fields">
          <label className="admin-field grow">
            소속 리그
            <select
              value={leagueId}
              onChange={(e) => setLeagueId(e.target.value)}
              data-testid="team-modal-league"
            >
              {leagues.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field">
            체급
            <select
              value={tier}
              onChange={(e) => setTier(numOf(e.target.value) as Grade)}
              data-testid="team-modal-tier"
            >
              {GRADES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field">
            기본 포메이션
            <select
              value={formation}
              onChange={(e) => setFormation(e.target.value)}
              data-testid="team-modal-formation"
            >
              <option value="">— (기본값)</option>
              {FORMATIONS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field">
            전술 성향
            <select
              value={tacticalStyle}
              onChange={(e) => setTacticalStyle(e.target.value as TacticalStyle)}
              data-testid="team-modal-style"
            >
              {TACTICAL_STYLES.map((s) => (
                <option key={s} value={s}>
                  {TACTICAL_STYLE_KO[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section>
        <div className="admin-section-head">
          <b className="admin-section-title">살림</b>
          <span className="admin-section-note">매치데이 수입과 상업 수입의 기준</span>
        </div>
        <div className="admin-fields">
          <label className="admin-field grow">
            구장
            <input
              value={stadium}
              onChange={(e) => setStadium(e.target.value)}
              data-testid="team-modal-stadium"
            />
          </label>
          <label className="admin-field">
            수용인원
            <input
              className="ai num money"
              type="number"
              min={1}
              max={MAX_CAPACITY}
              step={1000}
              value={capacity}
              onChange={(e) => setCapacity(numOf(e.target.value))}
              data-testid="team-modal-capacity"
            />
          </label>
          <label className="admin-field">
            상업 등급
            <select
              value={commercialTier}
              onChange={(e) => setCommercialTier(numOf(e.target.value) as Grade)}
              data-testid="team-modal-commercial"
            >
              {GRADES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
    </Modal>
  );
}
