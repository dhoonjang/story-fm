"use client";

import { useEffect, useMemo, useState } from "react";
import type { CatalogLayer } from "./catalog-store";
import { PlayerModal } from "./player-modal";
import { groupTeamsByLeague, splitPositions } from "./types";
import type { CatalogResponse, PlayerRow } from "./types";

/**
 * 선수 카탈로그 패널 — 목록은 **요약만** 보여주고 편집은 팝업이 맡는다.
 * 16축까지 표에 펼치면 좌우 스크롤 없이는 읽을 수 없고, 그러면 "누구의 값인지"를
 * 스크롤이 계속 잡아먹는다.
 *
 * 카탈로그는 페이지가 쥐고 있다 (`catalog-store.ts`) — 이 패널은 받은 값을 그리고,
 * 편집·리셋 응답은 `onApply`로 올려 보낸다.
 */

const PAGE_SIZES = [25, 50, 100, 200] as const;
const DEFAULT_PAGE_SIZE = 50;
/**
 * 팀 필터 한 칸이 팀과 리그를 함께 받는다 — 셀렉트를 둘로 늘리면 "리그를 골랐는데
 * 팀은 안 골랐다"는 중간 상태가 생긴다. 팀 id와 섞이지 않게 접두사를 붙인다.
 */
const LEAGUE_PREFIX = "league:";

type ModalTarget = { mode: "create" } | { mode: "edit"; player: PlayerRow };

/**
 * 목록 행 — 화면이 거르고 보여 주는 값을 미리 붙여 둔다. 포지션은 선호·겸업으로
 * 갈려 있어야 검색도 표시도 같은 것을 보고, 리그는 필터가 그걸로 거른다.
 */
type ListRow = PlayerRow & ReturnType<typeof splitPositions> & { leagueId: string };

export function PlayersPanel({
  catalog,
  onApply,
  onMessage,
  onError,
}: {
  catalog: CatalogLayer<CatalogResponse>;
  onApply: (data: CatalogResponse) => void;
  onMessage: (m: string | null) => void;
  onError: (e: string | null) => void;
}) {
  const [teamFilter, setTeamFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<ModalTarget | null>(null);
  const [busy, setBusy] = useState(false);

  const teams = catalog.data.teams;
  const edited = catalog.data.edited ?? false;
  const ageRef = catalog.data.ageRef ?? "";
  const loaded = catalog.loaded;

  const teamGroups = useMemo(() => groupTeamsByLeague(teams), [teams]);
  const flat = useMemo<ListRow[]>(
    () =>
      teams.flatMap((t) =>
        t.players.map((p) => ({
          ...p,
          teamName: t.teamName,
          leagueId: t.leagueId,
          ...splitPositions(p.positions),
        })),
      ),
    [teams],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const league = teamFilter.startsWith(LEAGUE_PREFIX)
      ? teamFilter.slice(LEAGUE_PREFIX.length)
      : null;
    return flat.filter((p) => {
      if (league !== null) {
        if (p.leagueId !== league) return false;
      } else if (teamFilter !== "all" && p.teamId !== teamFilter) return false;
      // 검색은 칸에 **보이는 자리를 다** 훑는다 — 겸업으로 DM을 보는 센터백이
      // "DM"에 안 걸리면 화면이 보여 준 것과 검색이 어긋난다
      const codes = [...p.natural, ...p.other].join(" ");
      if (q && !`${p.nameKo} ${p.nameEn} ${codes} ${p.teamName}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [flat, teamFilter, query]);

  /**
   * 새 선수가 들어갈 팀 — 지금 걸어 둔 필터를 따른다. 리그로 걸어 뒀으면 팀까지는
   * 못 정하므로 그 리그의 첫 팀이다 (창에서 다시 고를 수 있다).
   */
  const defaultTeamId = useMemo(() => {
    if (teamFilter.startsWith(LEAGUE_PREFIX)) {
      const id = teamFilter.slice(LEAGUE_PREFIX.length);
      return teamGroups.find((g) => g.leagueId === id)?.teams[0]?.id ?? "";
    }
    if (teamFilter !== "all") return teamFilter;
    return teams[0]?.teamId ?? "";
  }, [teamFilter, teamGroups, teams]);

  /** 필터·검색·페이지 크기가 바뀌면 첫 페이지로 */
  useEffect(() => setPage(1), [teamFilter, query, pageSize]);

  // 삭제 등으로 목록이 줄어 현재 페이지가 사라졌으면 마지막 페이지로 접는다.
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const current = Math.min(page, pageCount);
  const from = (current - 1) * pageSize;
  const paged = useMemo(() => visible.slice(from, from + pageSize), [visible, from, pageSize]);

  async function resetCatalog() {
    if (!window.confirm("카탈로그 편집을 모두 취소하고 시드 기본값으로 되돌릴까요?")) return;
    setBusy(true);
    onError(null);
    onMessage(null);
    try {
      const res = await fetch("/api/admin/catalog", { method: "DELETE" });
      const data: CatalogResponse = await res.json();
      if (!res.ok) throw new Error(data.error ?? "되돌리기 실패");
      onApply(data);
      onMessage(data.message ?? null);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function openPlayer(p: PlayerRow) {
    onMessage(null);
    onError(null);
    setTarget({ mode: "edit", player: p });
  }

  return (
    <section className="admin-panel">
      {/* 이 안내는 남긴다 — "편집이 진행 중 세이브에 안 먹는다"는 화면만 봐선 모른다 */}
      <p className="hint admin-note">
        편집 결과는 <b>이후 새로 시작하는 게임</b>에만 반영됩니다 — 진행 중인 게임은 시작 시 복사한
        값으로 계속 돕니다. 나이·OVR은 파생값이라 저장하지 않습니다
        {ageRef ? ` (나이는 ${ageRef} 기준)` : ""}.
      </p>

      <div className="admin-toolbar">
        <select
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}
          data-testid="admin-team-filter"
          aria-label="팀 필터"
        >
          <option value="all">전체 팀</option>
          {/* 리그도 하나의 선택지다 — 팀 하나로 좁히기 전에 리그를 먼저 볼 수 있어야 한다 */}
          {teamGroups.map((g) => (
            <optgroup key={g.leagueId} label={g.leagueName}>
              <option value={`${LEAGUE_PREFIX}${g.leagueId}`}>{g.leagueName} 전체</option>
              {g.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} (T{t.tier})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <input
          className="admin-search"
          placeholder="이름·로마자·포지션·팀 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="admin-search"
        />
        <span className="admin-count" data-testid="admin-count">
          {visible.length === 0
            ? "0명"
            : `${(from + 1).toLocaleString()}–${(from + paged.length).toLocaleString()} / ${visible.length.toLocaleString()}명`}
        </span>
        <select
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
          data-testid="admin-page-size"
          aria-label="페이지당 선수 수"
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}명씩
            </option>
          ))}
        </select>
        <div className="admin-toolbar-right">
          {edited && (
            <span className="badge warn" data-testid="catalog-edited">
              편집됨
            </span>
          )}
          <button
            className="ghost-btn"
            onClick={() => void resetCatalog()}
            disabled={busy || !edited}
            data-testid="catalog-reset"
          >
            시드 기본값으로
          </button>
          <button
            className="primary-btn admin-add-btn"
            onClick={() => setTarget({ mode: "create" })}
            disabled={teams.length === 0}
            data-testid="admin-add-toggle"
          >
            + 새 선수
          </button>
        </div>
      </div>

      <div className="admin-list-wrap">
        <table className="admin-list">
          <thead>
            <tr>
              <th className="hide-sm">팀</th>
              <th>이름</th>
              <th>포지션</th>
              <th className="num">나이</th>
              <th className="num">OVR</th>
              <th className="num">POT</th>
              <th className="num">주급</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((p) => (
              <tr
                key={p.id}
                data-testid={`admin-row-${p.id}`}
                tabIndex={0}
                role="button"
                aria-label={`${p.nameKo} 편집`}
                onClick={() => openPlayer(p)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openPlayer(p);
                  }
                }}
              >
                <td className="admin-team hide-sm">{p.teamName}</td>
                <td className="admin-name">
                  {p.nameKo}
                  <span className="muted">{p.nameEn}</span>
                </td>
                <td className="admin-pos-cell">
                  {p.natural.map((code) => (
                    <span className="admin-pos" key={code}>
                      {code}
                    </span>
                  ))}
                  {p.other.length > 0 && (
                    <span className="admin-pos-more">{p.other.join(" · ")}</span>
                  )}
                </td>
                <td className="num">{p.age}</td>
                <td className="num admin-ovr">{p.overall}</td>
                <td className="num">{p.potential}</td>
                <td className="num">{p.weeklyWage ? `£${p.weeklyWage.toLocaleString()}` : "—"}</td>
              </tr>
            ))}
            {paged.length === 0 && (
              <tr className="admin-list-empty">
                {/* 아직 못 불러온 것과 없는 것은 다르다 — 5천 명을 받는 동안 "없다"고 하지 않는다 */}
                <td colSpan={7}>
                  {loaded ? "조건에 맞는 선수가 없습니다" : "카탈로그를 불러오는 중…"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {visible.length > 0 && (
        <nav className="admin-pager" data-testid="admin-pager" aria-label="페이지 이동">
          <button
            className="mini-btn"
            onClick={() => setPage(1)}
            disabled={current === 1}
            data-testid="admin-page-first"
          >
            ‹‹
          </button>
          <button
            className="mini-btn"
            onClick={() => setPage(current - 1)}
            disabled={current === 1}
            data-testid="admin-page-prev"
          >
            이전
          </button>
          <span className="admin-page-info" data-testid="admin-page-info">
            <input
              className="ai num"
              type="number"
              min={1}
              max={pageCount}
              value={current}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setPage(Math.min(Math.max(1, Math.trunc(n)), pageCount));
              }}
              aria-label="페이지 번호"
              data-testid="admin-page-input"
            />
            <span className="muted"> / {pageCount}</span>
          </span>
          <button
            className="mini-btn"
            onClick={() => setPage(current + 1)}
            disabled={current === pageCount}
            data-testid="admin-page-next"
          >
            다음
          </button>
          <button
            className="mini-btn"
            onClick={() => setPage(pageCount)}
            disabled={current === pageCount}
            data-testid="admin-page-last"
          >
            ››
          </button>
        </nav>
      )}

      {target && (
        <PlayerModal
          mode={target.mode}
          player={target.mode === "edit" ? target.player : undefined}
          teamGroups={teamGroups}
          defaultTeamId={defaultTeamId}
          ageRef={ageRef}
          onSaved={(data) => {
            onApply(data);
            onMessage(data.message ?? null);
            setTarget(null);
          }}
          onClose={() => setTarget(null)}
        />
      )}
    </section>
  );
}
