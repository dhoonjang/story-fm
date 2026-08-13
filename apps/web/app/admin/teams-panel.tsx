"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { TeamModal } from "./team-modal";
import {
  TACTICAL_STYLE_KO,
  type AdminTeamRow,
  type LeagueCatalogResponse,
  type TeamCatalogResponse,
} from "./types";

/**
 * 팀 카탈로그 패널 — 선수 탭과 같은 규칙이다: 목록은 요약만 보여주고 편집은
 * 팝업이 맡는다.
 *
 * 리그 목록을 따로 불러오는 이유: 팝업의 리그 셀렉트가 **팀이 없는 리그**까지
 * 보여야 한다 (팀을 그 리그로 옮기는 것이 정당한 편집이다). 행에서 파생하면
 * 빈 리그가 목록에서 사라진다.
 */

type ModalTarget = { mode: "create" } | { mode: "edit"; team: AdminTeamRow };

export function TeamsPanel({
  onMessage,
  onError,
}: {
  onMessage: (m: string | null) => void;
  onError: (e: string | null) => void;
}) {
  const [teams, setTeams] = useState<AdminTeamRow[]>([]);
  const [leagues, setLeagues] = useState<Array<{ id: string; name: string }>>([]);
  const [edited, setEdited] = useState(false);
  const [leagueFilter, setLeagueFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<ModalTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const applyResponse = useCallback((data: TeamCatalogResponse) => {
    setTeams(data.teams ?? []);
    if (data.edited !== undefined) setEdited(data.edited);
  }, []);

  useEffect(() => {
    fetch("/api/admin/catalog/team")
      .then((r) => r.json())
      .then((d: TeamCatalogResponse) => {
        if (d.error) onError(d.error);
        else applyResponse(d);
        setLoaded(true);
      })
      .catch(() => {
        onError("팀 카탈로그를 불러오지 못했습니다");
        setLoaded(true);
      });
    fetch("/api/admin/catalog/league")
      .then((r) => r.json())
      .then((d: LeagueCatalogResponse) => {
        setLeagues((d.leagues ?? []).map((l) => ({ id: l.id, name: l.name })));
      })
      .catch(() => onError("리그 목록을 불러오지 못했습니다"));
  }, [applyResponse, onError]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return teams.filter((t) => {
      if (leagueFilter !== "all" && t.leagueId !== leagueFilter) return false;
      if (q && !`${t.id} ${t.name} ${t.shortName} ${t.stadium}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [teams, leagueFilter, query]);

  async function resetTeams() {
    if (!window.confirm("팀 편집을 모두 취소하고 시드 기본값으로 되돌릴까요?")) return;
    setBusy(true);
    onError(null);
    onMessage(null);
    try {
      const res = await fetch("/api/admin/catalog/team", { method: "DELETE" });
      const data: TeamCatalogResponse = await res.json();
      if (!res.ok) throw new Error(data.error ?? "되돌리기 실패");
      applyResponse(data);
      onMessage(data.message ?? null);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function openTeam(t: AdminTeamRow) {
    onMessage(null);
    onError(null);
    setTarget({ mode: "edit", team: t });
  }

  return (
    <section className="admin-panel">
      <p className="hint admin-note">
        편집 결과는 <b>이후 새로 시작하는 게임</b>에만 반영됩니다 — 진행 중인 게임은 시작 시 복사한
        값으로 계속 돕니다. 리그 소속·팀 추가/삭제는 구조 필드라, 세계가 성립하지 않는 편집은 저장할
        때 막힙니다.
      </p>

      <div className="admin-toolbar">
        <select
          value={leagueFilter}
          onChange={(e) => setLeagueFilter(e.target.value)}
          data-testid="admin-league-filter"
          aria-label="리그 필터"
        >
          <option value="all">전체 리그</option>
          {leagues.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <input
          className="admin-search"
          placeholder="팀 이름·약칭·id·구장 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="admin-team-search"
        />
        <span className="admin-count" data-testid="admin-team-count">
          {visible.length.toLocaleString()}팀
        </span>
        <div className="admin-toolbar-right">
          {edited && (
            <span className="badge warn" data-testid="teams-edited">
              편집됨
            </span>
          )}
          <button
            className="ghost-btn"
            onClick={() => void resetTeams()}
            disabled={busy || !edited}
            data-testid="teams-reset"
          >
            시드 기본값으로
          </button>
          <button
            className="primary-btn admin-add-btn"
            onClick={() => setTarget({ mode: "create" })}
            disabled={leagues.length === 0}
            data-testid="team-add"
          >
            + 새 팀
          </button>
        </div>
      </div>

      <div className="admin-list-wrap">
        <table className="admin-list">
          <thead>
            <tr>
              <th className="hide-sm">리그</th>
              <th>이름</th>
              <th className="num">체급</th>
              <th>포메이션</th>
              <th>전술</th>
              <th className="hide-sm">구장</th>
              <th className="num">상업</th>
              <th className="num">스쿼드</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((t) => (
              <tr
                key={t.id}
                data-testid={`team-row-${t.id}`}
                tabIndex={0}
                role="button"
                aria-label={`${t.name} 편집`}
                onClick={() => openTeam(t)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openTeam(t);
                  }
                }}
              >
                <td className="admin-team hide-sm">{t.leagueName}</td>
                <td className="admin-name">
                  {t.name}
                  <span className="muted">{t.shortName}</span>
                </td>
                <td className="num admin-ovr">{t.tier}</td>
                <td>{t.formation ?? "—"}</td>
                <td>{TACTICAL_STYLE_KO[t.tacticalStyle]}</td>
                <td className="admin-name hide-sm">
                  {t.stadium}
                  <span className="muted">{t.capacity.toLocaleString()}석</span>
                </td>
                <td className="num">{t.commercialTier}</td>
                <td className="num">{t.squadSize}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr className="admin-list-empty">
                <td colSpan={8}>{loaded ? "조건에 맞는 팀이 없습니다" : "팀 카탈로그를 불러오는 중…"}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {target && (
        <TeamModal
          mode={target.mode}
          team={target.mode === "edit" ? target.team : undefined}
          leagues={leagues}
          defaultLeagueId={leagueFilter !== "all" ? leagueFilter : (leagues[0]?.id ?? "")}
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
