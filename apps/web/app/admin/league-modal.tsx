"use client";

import { useState } from "react";
import { Modal } from "./modal";
import {
  LEAGUE_KINDS,
  LEAGUE_KIND_KO,
  changedFields,
  numOf,
  type AdminLeagueRow,
  type LeagueCatalogResponse,
  type LeagueKind,
} from "./types";

/**
 * 리그 편집 창 — 추가와 편집이 같은 창을 쓴다.
 *
 * `kind`가 리그의 **정체**다: 리그전을 도는가(playable), 컵 참가만 하는가(cup-only),
 * 경기를 아예 하지 않는가(market-only), 리그 밖인가(free). 바꾸면 달력과 순위표가
 * 함께 바뀌므로 판정은 엔진 불변식에 맡기고, 실패 메시지는 이 창에 남긴다.
 */

const MAX_COEFFICIENT = 99;
const MAX_BROADCAST = 10;
const MAX_TICKET = 10_000;
const ID_RE = /^[a-z0-9-]+$/;

type Mode = "create" | "edit";

interface LeagueFields {
  name: string;
  country: string;
  kind: LeagueKind;
  coefficient: number;
  realSquads: boolean;
  broadcastPool: number;
  avgTicketPrice: number;
}

export function LeagueModal({
  mode,
  league,
  onSaved,
  onClose,
}: {
  mode: Mode;
  /** 편집 모드에서만 있다 */
  league?: AdminLeagueRow;
  onSaved: (data: LeagueCatalogResponse) => void;
  onClose: () => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState(league?.name ?? "");
  const [country, setCountry] = useState(league?.country ?? "");
  const [kind, setKind] = useState<LeagueKind>(league?.kind ?? "playable");
  const [coefficient, setCoefficient] = useState(league?.coefficient ?? 10);
  const [realSquads, setRealSquads] = useState(league?.realSquads ?? false);
  const [broadcastPool, setBroadcastPool] = useState(league?.broadcastPool ?? 0);
  const [avgTicketPrice, setAvgTicketPrice] = useState(league?.avgTicketPrice ?? 0);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const fields: LeagueFields = {
    name: name.trim(),
    country: country.trim(),
    kind,
    coefficient,
    realSquads,
    broadcastPool,
    avgTicketPrice,
  };

  function validate(): string | null {
    if (mode === "create" && !ID_RE.test(id.trim())) {
      return "리그 id는 영소문자·숫자·하이픈만 쓸 수 있습니다";
    }
    if (!fields.name) return "리그 이름을 입력하세요";
    if (!fields.country) return "나라를 입력하세요";
    if (fields.coefficient < 1 || fields.coefficient > MAX_COEFFICIENT) {
      return `계수는 1~${MAX_COEFFICIENT} 사이여야 합니다`;
    }
    if (fields.broadcastPool < 0 || fields.broadcastPool > MAX_BROADCAST) {
      return `중계권 배율은 0~${MAX_BROADCAST} 사이여야 합니다`;
    }
    if (fields.avgTicketPrice < 0 || fields.avgTicketPrice > MAX_TICKET) {
      return `평균 티켓 단가는 0~${MAX_TICKET.toLocaleString()} 사이여야 합니다`;
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
      body = { id: id.trim(), ...fields };
    } else {
      const patch = changedFields<LeagueFields>(
        {
          name: league!.name,
          country: league!.country,
          kind: league!.kind,
          coefficient: league!.coefficient,
          realSquads: league!.realSquads,
          broadcastPool: league!.broadcastPool,
          avgTicketPrice: league!.avgTicketPrice,
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
        mode === "create" ? "/api/admin/catalog/league" : `/api/admin/catalog/league/${league!.id}`,
        {
          method: mode === "create" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data: LeagueCatalogResponse = await res.json();
      if (!res.ok) throw new Error(data.error ?? "요청 실패");
      onSaved(data);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!league) return;
    // 소속 팀이 남아 있으면 엔진도 막는다 — 먼저 말해 주면 삭제를 눌러 보지 않는다
    if (league.teamCount > 0) {
      setFormError(`${league.name}에 아직 ${league.teamCount}팀이 있습니다 — 팀을 먼저 옮기거나 지우세요`);
      return;
    }
    if (!window.confirm(`카탈로그에서 ${league.name}을(를) 삭제할까요?\n(새 게임부터 반영됩니다)`)) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/catalog/league/${league.id}`, { method: "DELETE" });
      const data: LeagueCatalogResponse = await res.json();
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
      testId="league-modal"
      title={mode === "create" ? "새 리그" : `${name || league?.name} 편집`}
      subtitle={
        mode === "create"
          ? "카탈로그에 추가합니다 — 새로 시작하는 게임부터 반영됩니다"
          : `${league?.id} · 소속 ${league?.teamCount}팀`
      }
      onClose={onClose}
      footer={
        <>
          <button
            className="primary-btn"
            onClick={() => void save()}
            disabled={saving}
            data-testid="league-modal-save"
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
              data-testid="league-modal-delete"
            >
              삭제
            </button>
          )}
        </>
      }
    >
      {formError && (
        <div className="admin-msg err" data-testid="league-modal-err">
          {formError}
        </div>
      )}

      <div className="admin-fields">
        {mode === "create" && (
          <label className="admin-field grow">
            리그 id
            <input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="예: eredivisie"
              data-testid="league-modal-id"
            />
          </label>
        )}
        <label className="admin-field grow">
          이름
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 프리미어리그"
            data-testid="league-modal-name"
          />
        </label>
        <label className="admin-field">
          나라
          <input
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            placeholder="예: 잉글랜드"
            data-testid="league-modal-country"
          />
        </label>
      </div>

      <section>
        <div className="admin-section-head">
          <b className="admin-section-title">리그가 하는 일</b>
          <span className="admin-section-note">
            달력·순위표·대항전 티켓이 여기서 갈립니다 — 바꾸면 새 게임의 세계 모양이 달라집니다
          </span>
        </div>
        <div className="admin-fields">
          <label className="admin-field grow">
            종류
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as LeagueKind)}
              data-testid="league-modal-kind"
            >
              {LEAGUE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {LEAGUE_KIND_KO[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field">
            계수 (1이 최강)
            <input
              className="ai num"
              type="number"
              min={1}
              max={MAX_COEFFICIENT}
              value={coefficient}
              onChange={(e) => setCoefficient(numOf(e.target.value))}
              data-testid="league-modal-coefficient"
            />
          </label>
          <label className="admin-field admin-check">
            <input
              type="checkbox"
              checked={realSquads}
              onChange={(e) => setRealSquads(e.target.checked)}
              data-testid="league-modal-real"
            />
            실선수 시드 사용
          </label>
        </div>
      </section>

      <section>
        <div className="admin-section-head">
          <b className="admin-section-title">돈</b>
          <span className="admin-section-note">중계권 배율은 EPL 1.00 기준</span>
        </div>
        <div className="admin-fields">
          <label className="admin-field">
            중계권 배율
            <input
              className="ai num"
              type="number"
              min={0}
              max={MAX_BROADCAST}
              step={0.05}
              value={broadcastPool}
              onChange={(e) => setBroadcastPool(numOf(e.target.value))}
              data-testid="league-modal-broadcast"
            />
          </label>
          <label className="admin-field">
            평균 티켓 단가 (£)
            <input
              className="ai num"
              type="number"
              min={0}
              max={MAX_TICKET}
              value={avgTicketPrice}
              onChange={(e) => setAvgTicketPrice(numOf(e.target.value))}
              data-testid="league-modal-ticket"
            />
          </label>
        </div>
      </section>
    </Modal>
  );
}
