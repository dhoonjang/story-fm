"use client";

import { useMemo, useState } from "react";
import {
  CLUB_HI_MIN_CONTRAST,
  CLUB_TONE_SURFACE,
  CREST_MIN_INK_CONTRAST,
  clubTonesOf,
  contrastRatio,
  type ClubColours,
} from "@story-fm/domain";
import { Crest, cachedCrest, clubWash } from "@/components/crest";
import type { CatalogLayer } from "./catalog-store";
import type { AdminTeamRow, TeamCatalogResponse } from "./types";

/**
 * 팔레트 시트 — 구단 색과 화면용 밝힘을 **한 화면에서** 검수한다
 * (ui/design-system.md §2 「검수」).
 *
 * 조율은 개별 구단이 아니라 전체 팔레트를 상대로만 한다 — 한 구단을 보기 좋게 고치는
 * 순간 규칙이 아니라 취향이 된다(team.md §3.1). 그래서 여기는 **읽기 전용**이다: 값은
 * `packages/engine/src/data/club-colours.ts` 하나가 갖고, 팀 편집 창은 `colours`를
 * 노출하지 않는다.
 *
 * 견본은 저마다 **실제로 설 표면** 위에 앉는다. 밝힘은 `--panel-2`, 워시와 플랭크는
 * `--panel`이다 — 표 배경 위에 대충 세우면 눈으로 본 것과 옆 칸의 대비 수치가 갈린다.
 */

/** 한 행 — 카탈로그 항목 하나에서 색·밝힘·대비를 낸 것 */
interface PaletteRow {
  id: string;
  name: string;
  shortName: string;
  leagueId: string;
  leagueName: string;
  /** 공식 색 — 없는 구단은 아래 색이 전부 문장의 해시 값이다 */
  colours?: ClubColours;
  primary: string;
  secondary: string;
  /** 공식 강조색. 없는 구단(해시·흑백)은 빈 문자열 */
  accent: string;
  /** 문장 글자·윤곽선 */
  ink: string;
  /** `--club-hi` — 띠와 레일이 쓰는 색 */
  hi: string;
  /** 공식 값을 그대로 못 쓰고 명도만 올렸는가 */
  lifted: boolean;
  /** `--club-hi` ↔ `--panel-2` — 문턱 3:1 (WCAG 비텍스트) */
  rail: number;
  /** 문장 잉크 ↔ 밑색 — 목표 4.5, 공식 색은 닿을 수 있는 최대까지 */
  inkOn: number;
}

type SortKey = "league" | "rail";

const SORTS = [
  ["league", "리그순"],
  ["rail", "대비순"],
] as const satisfies ReadonlyArray<readonly [SortKey, string]>;

function paletteRow(team: AdminTeamRow): PaletteRow {
  const crest = cachedCrest(team.id, team.shortName, team.colours);
  const tones = clubTonesOf(crest, team.colours);
  return {
    id: team.id,
    name: team.name,
    shortName: team.shortName,
    leagueId: team.leagueId,
    leagueName: team.leagueName,
    colours: team.colours,
    primary: crest.primary,
    secondary: crest.secondary,
    accent: team.colours?.accent ?? "",
    ink: crest.ink,
    hi: tones.hi,
    lifted: tones.lifted,
    rail: contrastRatio(tones.hi, CLUB_TONE_SURFACE.panel2),
    inkOn: contrastRatio(crest.ink, crest.primary),
  };
}

/** 색 한 칸 — 면과 값이 나란히 서야 hex를 보며 눈으로 대조할 수 있다 */
function Swatch({ colour }: { colour: string }) {
  if (colour === "") return <span className="palette-none">—</span>;
  return (
    <span className="palette-swatch">
      <i style={{ background: colour }} />
      <code>{colour}</code>
    </span>
  );
}

/**
 * 대비 한 칸 — 문턱 아래는 패의 색, 목표에 못 미치면 주의의 색.
 * **숫자는 코어가 갖는다** (`CLUB_HI_MIN_CONTRAST` · `CREST_MIN_INK_CONTRAST`).
 */
function Contrast({ value, floor, target }: { value: number; floor: number; target: number }) {
  const state = value < floor ? "palette-under" : value < target ? "palette-near" : undefined;
  return <span className={state}>{value.toFixed(2)}</span>;
}

function PaletteRowCells({ row, showLeague }: { row: PaletteRow; showLeague: boolean }) {
  return (
    <>
      <td>
        <Crest id={row.id} shortName={row.shortName} colours={row.colours} size={32} />
      </td>
      <td className="admin-name">
        {row.name}
        <span className="muted">{row.shortName}</span>
        {row.colours === undefined && <span className="palette-tag">해시</span>}
        {showLeague && <span className="palette-tag">{row.leagueName}</span>}
      </td>
      <td>
        <Swatch colour={row.primary} />
      </td>
      <td>
        <Swatch colour={row.secondary} />
      </td>
      <td>
        <Swatch colour={row.accent} />
      </td>
      <td>
        <span className="palette-hi">
          <span className="palette-rail">
            <i style={{ background: row.hi }} />
          </span>
          <code>{row.hi}</code>
          {row.lifted && <span className="palette-tag">올림</span>}
        </span>
      </td>
      <td>
        <span className="palette-wash" style={{ background: clubWash(row.primary) }}>
          {row.shortName}
        </span>
      </td>
      <td>
        <span className="palette-flank">
          <i style={{ background: row.primary }} />
          <i style={{ background: row.secondary }} />
        </span>
      </td>
      <td className="num">
        <Contrast value={row.rail} floor={CLUB_HI_MIN_CONTRAST} target={CLUB_HI_MIN_CONTRAST} />
      </td>
      <td className="num">
        <Contrast value={row.inkOn} floor={CLUB_HI_MIN_CONTRAST} target={CREST_MIN_INK_CONTRAST} />
      </td>
    </>
  );
}

/** 열 수 — 리그 머리 행과 빈 행이 표를 가로지른다 */
const COLUMNS = 10;

export function PalettePanel({ teams }: { teams: CatalogLayer<TeamCatalogResponse> }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("league");

  const rows = useMemo(() => teams.data.teams.map(paletteRow), [teams.data.teams]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? rows.filter((r) =>
          `${r.id} ${r.name} ${r.shortName} ${r.leagueName} ${r.primary} ${r.secondary} ${r.accent} ${r.hi}`
            .toLowerCase()
            .includes(q),
        )
      : rows;
    // 리그순은 **받은 순서 그대로**다 — 엔진의 팀 표가 이미 리그 순서로 늘어서 있어
    // 여기서 다시 정렬하면 팀 탭과 순서가 갈린다 (`groupTeamsByLeague`와 같은 규칙).
    // 대비순은 문턱에 가장 가까운 구단이 맨 위 — 팔레트를 상대로 보는 자리다.
    return sort === "league" ? matched : [...matched].sort((a, b) => a.rail - b.rail);
  }, [rows, query, sort]);

  const official = visible.filter((r) => r.colours !== undefined).length;

  return (
    <section className="admin-panel">
      <p className="hint admin-note">
        값은 각 구단의 <b>공식 색</b> 그대로이고 출처는 원장(sources.md §7.5)입니다 — 이 시트는 읽기
        전용입니다. 공식 색이 없는 구단(「해시」)은 문장의 해시 색이 같은 규칙을 지납니다.
      </p>

      <div className="admin-toolbar">
        <input
          className="admin-search"
          placeholder="구단·리그·id·hex 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="admin-palette-search"
        />
        <span className="admin-count" data-testid="admin-palette-count">
          공식 {official.toLocaleString()} · 해시 {(visible.length - official).toLocaleString()}
        </span>
        <div className="admin-toolbar-right">
          <div className="side-tabs" role="tablist" aria-label="시트 정렬">
            {SORTS.map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={sort === key}
                className={sort === key ? "side-tab on" : "side-tab"}
                onClick={() => setSort(key)}
                data-testid={`palette-sort-${key}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="admin-list-wrap">
        <table className="admin-list palette-list">
          <thead>
            <tr>
              <th>문장</th>
              <th>구단</th>
              <th>원색</th>
              <th>보조</th>
              <th>강조</th>
              <th>밝힘</th>
              <th>워시</th>
              <th>플랭크</th>
              {/* 문턱은 그 열 위에 선다 — 숫자는 코어가 갖고 화면은 세우기만 한다 */}
              <th className="num">
                띠 대비 <span className="muted">{CLUB_HI_MIN_CONTRAST}:1</span>
              </th>
              <th className="num">
                잉크 대비 <span className="muted">{CREST_MIN_INK_CONTRAST}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.flatMap((row, at) => {
              const head =
                sort === "league" && visible[at - 1]?.leagueId !== row.leagueId ? (
                  <tr className="palette-group" key={`head-${row.leagueId}`}>
                    <td colSpan={COLUMNS}>{row.leagueName}</td>
                  </tr>
                ) : null;
              return [
                head,
                <tr key={row.id} data-testid={`palette-row-${row.id}`}>
                  <PaletteRowCells row={row} showLeague={sort === "rail"} />
                </tr>,
              ];
            })}
            {visible.length === 0 && (
              <tr className="admin-list-empty">
                <td colSpan={COLUMNS}>
                  {teams.loaded ? "해당하는 구단이 없습니다" : "불러오는 중…"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
