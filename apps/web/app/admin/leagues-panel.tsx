"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LeagueModal } from "./league-modal";
import { LEAGUE_KIND_KO, type AdminLeagueRow, type LeagueCatalogResponse } from "./types";

/**
 * 리그 카탈로그 패널 — 대회의 불변 정의(종류·계수·중계권·티켓 단가)를 편집한다.
 * 팀 탭과 같은 규칙이다: 목록은 요약, 편집은 팝업.
 */

type ModalTarget = { mode: "create" } | { mode: "edit"; league: AdminLeagueRow };

export function LeaguesPanel({
  onMessage,
  onError,
}: {
  onMessage: (m: string | null) => void;
  onError: (e: string | null) => void;
}) {
  const [leagues, setLeagues] = useState<AdminLeagueRow[]>([]);
  const [edited, setEdited] = useState(false);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<ModalTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const applyResponse = useCallback((data: LeagueCatalogResponse) => {
    setLeagues(data.leagues ?? []);
    if (data.edited !== undefined) setEdited(data.edited);
  }, []);

  useEffect(() => {
    fetch("/api/admin/catalog/league")
      .then((r) => r.json())
      .then((d: LeagueCatalogResponse) => {
        if (d.error) onError(d.error);
        else applyResponse(d);
        setLoaded(true);
      })
      .catch(() => {
        onError("리그 카탈로그를 불러오지 못했습니다");
        setLoaded(true);
      });
  }, [applyResponse, onError]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return leagues;
    return leagues.filter((l) => `${l.id} ${l.name} ${l.country} ${l.kind}`.toLowerCase().includes(q));
  }, [leagues, query]);

  async function resetLeagues() {
    if (!window.confirm("리그 편집을 모두 취소하고 시드 기본값으로 되돌릴까요?")) return;
    setBusy(true);
    onError(null);
    onMessage(null);
    try {
      const res = await fetch("/api/admin/catalog/league", { method: "DELETE" });
      const data: LeagueCatalogResponse = await res.json();
      if (!res.ok) throw new Error(data.error ?? "되돌리기 실패");
      applyResponse(data);
      onMessage(data.message ?? null);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function openLeague(l: AdminLeagueRow) {
    onMessage(null);
    onError(null);
    setTarget({ mode: "edit", league: l });
  }

  return (
    <section className="admin-panel">
      <p className="hint admin-note">
        편집 결과는 <b>이후 새로 시작하는 게임</b>에만 반영됩니다 — 진행 중인 게임은 시작 시 복사한
        값으로 계속 돕니다. 리그 종류(kind)는 구조 필드라, 세계가 성립하지 않는 편집은 저장할 때
        막힙니다.
      </p>

      <div className="admin-toolbar">
        <input
          className="admin-search"
          placeholder="리그 이름·나라·id 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="admin-league-search"
        />
        <span className="admin-count" data-testid="admin-league-count">
          {visible.length.toLocaleString()}개
        </span>
        <div className="admin-toolbar-right">
          {edited && (
            <span className="badge warn" data-testid="leagues-edited">
              편집됨
            </span>
          )}
          <button
            className="ghost-btn"
            onClick={() => void resetLeagues()}
            disabled={busy || !edited}
            data-testid="leagues-reset"
          >
            시드 기본값으로
          </button>
          <button
            className="primary-btn admin-add-btn"
            onClick={() => setTarget({ mode: "create" })}
            data-testid="league-add"
          >
            + 새 리그
          </button>
        </div>
      </div>

      <div className="admin-list-wrap">
        <table className="admin-list">
          <thead>
            <tr>
              <th>이름</th>
              <th>나라</th>
              <th>종류</th>
              <th className="num">계수</th>
              <th className="num">중계 배율</th>
              <th className="num">티켓 단가</th>
              <th className="num">팀</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((l) => (
              <tr
                key={l.id}
                data-testid={`league-row-${l.id}`}
                tabIndex={0}
                role="button"
                aria-label={`${l.name} 편집`}
                onClick={() => openLeague(l)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openLeague(l);
                  }
                }}
              >
                <td className="admin-name">
                  {l.name}
                  <span className="muted">{l.id}</span>
                </td>
                <td>{l.country}</td>
                <td>
                  {LEAGUE_KIND_KO[l.kind]}
                  {l.realSquads && <span className="muted admin-pos-more">실선수</span>}
                </td>
                <td className="num">{l.coefficient}</td>
                <td className="num">{l.broadcastPool.toFixed(2)}</td>
                <td className="num">£{l.avgTicketPrice.toLocaleString()}</td>
                <td className="num admin-ovr">{l.teamCount}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr className="admin-list-empty">
                <td colSpan={7}>
                  {loaded ? "조건에 맞는 리그가 없습니다" : "리그 카탈로그를 불러오는 중…"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {target && (
        <LeagueModal
          mode={target.mode}
          league={target.mode === "edit" ? target.league : undefined}
          onSaved={(data) => {
            applyResponse(data);
            onMessage(data.message ?? null);
            setTarget(null);
          }}
          onClose={() => setTarget(null)}
        />
      )}
    </section>
  );
}
