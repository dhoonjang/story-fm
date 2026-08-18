"use client";

import { useCallback, useMemo, useState } from "react";
import type { CatalogLayer } from "./catalog-store";
import { SquadModal } from "./squad-modal";
import { TeamModal } from "./team-modal";
import {
  TACTICAL_STYLE_KO,
  type AdminLeagueRow,
  type AdminTeamRow,
  type CatalogResponse,
  type TeamCatalogResponse,
} from "./types";

/**
 * 팀 카탈로그 패널 — 선수 탭과 같은 규칙이다: 목록은 요약만 보여주고 편집은
 * 팝업이 맡는다. 팀 층도 선수 카탈로그도 페이지가 쥐고 있고(`catalog-store.ts`)
 * 이 패널은 받은 값을 그린다.
 *
 * 리그 목록이 팀 행과 따로 오는 이유: 팝업의 리그 셀렉트가 **팀이 없는 리그**까지
 * 보여야 한다 (팀을 그 리그로 옮기는 것이 정당한 편집이다). 행에서 파생하면
 * 빈 리그가 목록에서 사라진다.
 *
 * 한 행이 두 창을 연다: 행 자체는 팀 편집, 스쿼드 칸은 그 팀의 명단이다. 명단도
 * 스쿼드 인원도 팀 층이 아니라 **선수 카탈로그**에서 나오므로, 명단 창에서 선수를
 * 옮기면 뒤에 선 행의 인원이 함께 움직인다.
 */

type ModalTarget = { mode: "create" } | { mode: "edit"; team: AdminTeamRow };

export function TeamsPanel({
  teams,
  leagues,
  catalog,
  onApply,
  onPlayersApply,
  onMessage,
  onError,
}: {
  teams: CatalogLayer<TeamCatalogResponse>;
  leagues: AdminLeagueRow[];
  /** 선수 카탈로그 — 명단 창과 스쿼드 인원이 쓴다 */
  catalog: CatalogLayer<CatalogResponse>;
  onApply: (data: TeamCatalogResponse) => void;
  onPlayersApply: (data: CatalogResponse) => void;
  onMessage: (m: string | null) => void;
  onError: (e: string | null) => void;
}) {
  const [leagueFilter, setLeagueFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<ModalTarget | null>(null);
  const [squadTeam, setSquadTeam] = useState<AdminTeamRow | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = teams.data.teams;
  const edited = teams.data.edited ?? false;
  const loaded = teams.loaded;

  /** 스쿼드 인원 — 선수 카탈로그에서 센다 (명단 창에서 옮기면 즉시 줄어든다) */
  const squadSizes = useMemo(
    () => new Map(catalog.data.teams.map((t) => [t.teamId, t.players.length])),
    [catalog.data.teams],
  );
  // 선수 카탈로그가 아직 안 왔거나 방금 만든 팀이라 거기에 없으면 팀 행이 실어 온 수로
  const sizeOf = useCallback(
    (t: AdminTeamRow) => squadSizes.get(t.id) ?? t.squadSize,
    [squadSizes],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((t) => {
      if (leagueFilter !== "all" && t.leagueId !== leagueFilter) return false;
      if (q && !`${t.id} ${t.name} ${t.shortName} ${t.stadium}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [rows, leagueFilter, query]);

  async function resetTeams() {
    if (!window.confirm("팀 편집을 모두 취소하고 시드 기본값으로 되돌릴까요?")) return;
    setBusy(true);
    onError(null);
    onMessage(null);
    try {
      const res = await fetch("/api/admin/catalog/team", { method: "DELETE" });
      const data: TeamCatalogResponse = await res.json();
      if (!res.ok) throw new Error(data.error ?? "되돌리기 실패");
      onApply(data);
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
    setTarget({ mode: "edit", team: { ...t, squadSize: sizeOf(t) } });
  }

  function openSquad(t: AdminTeamRow) {
    onMessage(null);
    onError(null);
    setSquadTeam(t);
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
                  // 행 안의 명단 버튼에서 올라온 키는 팀 편집을 열지 않는다
                  if (e.target !== e.currentTarget) return;
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
                <td className="num">
                  <button
                    className="mini-btn admin-squad-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      openSquad(t);
                    }}
                    aria-label={`${t.name} 명단`}
                    data-testid={`team-squad-${t.id}`}
                  >
                    {sizeOf(t)}명
                  </button>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr className="admin-list-empty">
                <td colSpan={8}>
                  {loaded ? "조건에 맞는 팀이 없습니다" : "팀 카탈로그를 불러오는 중…"}
                </td>
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
            onApply(data);
            onMessage(data.message ?? null);
            setTarget(null);
          }}
          onClose={() => setTarget(null)}
        />
      )}

      {squadTeam && (
        <SquadModal
          team={{ id: squadTeam.id, name: squadTeam.name, leagueName: squadTeam.leagueName }}
          catalog={catalog.data.teams}
          loaded={catalog.loaded}
          onMoved={onPlayersApply}
          onClose={() => setSquadTeam(null)}
        />
      )}
    </section>
  );
}
