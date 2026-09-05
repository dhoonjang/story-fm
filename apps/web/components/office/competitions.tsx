"use client";

import { useState } from "react";
import {
  TACTIC_AXES,
  awardTitle,
  leaderboardTitle,
  outcomeLabel,
  tacticWord,
} from "@story-fm/domain";
import type { OfficeViews } from "@story-fm/engine";
import { IconChevron } from "../icons";
import { PlayerName } from "../player-card";

// ── 대회 — 대회별 탭 · 순위표 · 라운드별 일정 ──────────────
type Competition = OfficeViews["competitions"]["list"][number];
/** 다음 경기 조각 — 팀 단위와 대회 단위가 같은 모양이라 카드도 하나다 */
type NextMatch = NonNullable<OfficeViews["competitions"]["nextMatch"]>;
/** 최근 결과 한 경기 — 코어가 조각으로 내고 문장은 이 화면이 잇는다 */
type RecentResult = OfficeViews["competitions"]["recentResults"][number];
/** 경기 전 상대 분석 — 다음 경기 카드에 접혀 붙는다 (docs/simulation/match.md §1.8) */
type MatchPreview = NonNullable<OfficeViews["competitions"]["preview"]>;
/** 지나간 시즌 한 줄 — 우승·준우승·우리 순위 + 그 시즌의 최종 순위표와 시상 */
type PastSeason = Competition["pastSeasons"][number];
/** 그 시즌 그 리그의 시상 — 코어는 코드와 수치만 내고 이름·문장은 여기서 만든다 */
type SeasonAwardRow = PastSeason["awards"][number];
/** 개인 순위·팀 열 — 순위표가 없는 국내 컵은 null이다 */
type Leaders = NonNullable<Competition["leaders"]>;
type LeaderBoard = Leaders["players"][number];
type LeaderRow = LeaderBoard["rows"][number];

/**
 * 눈금 고르기 — 고를 수 있는 것은 라디오 묶음이라 무엇이 골라졌는지가 색만이 아니라
 * `aria-checked`로도 전해진다 (overview.md §5).
 */
function PillPicker<T extends string>({
  value,
  options,
  onPick,
  label,
  testId,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onPick: (value: T) => void;
  label: string;
  testId: string;
}) {
  return (
    <div className="pill-picker" role="radiogroup" aria-label={label} data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? "active" : ""}
          onClick={() => onPick(o.value)}
          data-testid={`${testId}-${o.value}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 순위표 세 벌 — 행은 같고 순서만 다르다 (docs/data/competition.md §2) */
const STANDING_SPLITS = [
  { value: "all", label: "전체" },
  { value: "home", label: "홈" },
  { value: "away", label: "원정" },
] as const;
type StandingSplit = (typeof STANDING_SPLITS)[number]["value"];

const venueLabel = (venue: NextMatch["venue"]) =>
  venue === "home" ? "홈" : venue === "away" ? "원정" : "중립";

/**
 * 순위표 — 리그는 그대로, 대항전은 통과 경계선을 긋는다.
 *
 * 전체·홈·원정 세 벌은 **코어가 이미 세워 둔 순서**를 고를 뿐이다 (overview.md §5) —
 * 여기서 다시 정렬하면 순위 규칙이 두 곳에 서고 그중 하나만 고쳐지는 날이 온다.
 */
function StandingsTable({ competition }: { competition: Competition }) {
  // 순위표를 갖는 대회는 리그와 대항전 리그 페이즈뿐이다 (국내 컵은 브래킷을 본다)
  const europe = competition.europe;
  const [split, setSplit] = useState<StandingSplit>("all");
  // 대회를 바꾸면 합계표로 돌아간다 — 남의 대회에서 고른 눈금이 따라오지 않는다
  const [ownerId, setOwnerId] = useState(competition.id);
  if (ownerId !== competition.id) {
    setOwnerId(competition.id);
    setSplit("all");
  }
  const rows =
    split === "home"
      ? competition.homeTable
      : split === "away"
        ? competition.awayTable
        : competition.standings;
  /**
   * 구역선은 **합계표의 사실**이다 — 원정 표 4위에 챔스 띠를 그으면 지키지 않을
   * 약속이 선다. 홈/원정 표에서는 띠도 범례도 서지 않는다.
   */
  const zones = split === "all" ? competition.zones : [];
  /**
   * 개막 전 언론이 매긴 예상 순위 (docs/simulation/season.md §2). 예상이 없는 대회·
   * 시즌(컵·대항전·옛 세이브)에는 **열 자체가 서지 않는다** — 전 행이 빈 열은 표를
   * 넓히기만 한다.
   */
  const predicted = rows.some((row) => row.predicted !== undefined);
  // 순위 → 그 순위가 속한 구역 (없으면 아무 뜻도 없는 자리)
  const zoneAt = (rank: number) => zones.find((z) => rank <= z.through) ?? null;
  return (
    <>
      <PillPicker
        value={split}
        options={STANDING_SPLITS}
        onPick={setSplit}
        label="순위표 범위"
        testId="standings-split"
      />
      <table data-testid={europe ? "europe-standings" : "standings"}>
        <thead>
          <tr>
            <th>#</th>
            <th>팀</th>
            {predicted ? <th className="dim-cell">예상</th> : null}
            <th>경기</th>
            <th>승</th>
            <th>무</th>
            <th>패</th>
            <th>득실</th>
            <th>승점</th>
            <th className="form-col">폼</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const zone = zoneAt(i + 1);
            // 홈 표·원정 표는 그 소계를 찍는다 — 합계를 찍으면 순서와 숫자가 어긋난다
            const box = split === "all" ? row : row[split];
            const diff = box.goalsFor - box.goalsAgainst;
            return (
              <tr
                key={row.teamId}
                className={[
                  row.ours ? "me" : "",
                  zone ? `zone zone-${zone.kind}` : "",
                  // 구역의 마지막 행 아래에 선을 긋는다 — 4위와 5위의 차이가 한 계단이 아니다
                  zone && zone.through === i + 1 ? "cut" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-testid={zone ? `standing-zone-${zone.kind}` : undefined}
              >
                {/* 순위 앞의 색 띠가 구역이다 — 무슨 구역인지는 툴팁과 표 아래 범례에 있다 */}
                <td title={zone?.label}>{i + 1}</td>
                <td className="team-cell">{row.name}</td>
                {predicted ? <td className="dim-cell">{row.predicted ?? "—"}</td> : null}
                {/* 열 하나가 늘면 자리로 짚던 것이 다 밀린다 — 세는 칸은 이름으로 짚는다 */}
                <td data-testid="standing-played">{box.played}</td>
                <td>{box.wins}</td>
                <td>{box.draws}</td>
                <td>{box.losses}</td>
                <td>{diff > 0 ? `+${diff}` : diff}</td>
                <td>
                  <b>{box.points}</b>
                </td>
                {/* 폼은 **합계의 최근 다섯**이다 — 홈 표에서도 흐름은 하나다 */}
                <td className="form-col">
                  <span className="form-run">
                    {row.form.map((o, k) => (
                      <i className={`form-mark form-${o}`} key={k}>
                        {outcomeLabel(o)}
                      </i>
                    ))}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ZoneLegend zones={zones} />
    </>
  );
}

/**
 * 구역 범례 — 색만으로는 "몇 위까지가 챔스인지" 알 수 없다.
 * 조작 안내가 아니라 데이터라서 화면에 둔다 (색 · 이름 · 순위 범위).
 */
function ZoneLegend({ zones }: { zones: Competition["zones"] }) {
  if (zones.length === 0) return null;
  return (
    <div className="zone-legend" data-testid="zone-legend">
      {zones.map((z, i) => {
        const from = i === 0 ? 1 : (zones[i - 1]?.through ?? 0) + 1;
        return (
          <span className={`zone-key zone-${z.kind}`} key={z.kind}>
            {z.label} {from === z.through ? `${from}위` : `${from}~${z.through}위`}
          </span>
        );
      })}
    </div>
  );
}

/**
 * 개인 순위 한 표가 세우는 열 — 축마다 다르고 **줄 세운 축이 굵게** 선다.
 * 코어가 준 수를 그대로 찍는다: 화면은 표기만 붙인다.
 */
function leaderColumns(
  key: LeaderBoard["key"],
): Array<{ head: string; of: (r: LeaderRow) => string; strong: boolean }> {
  const apps = { head: "경기", of: (r: LeaderRow) => String(r.apps), strong: false };
  if (key === "cleanSheets") {
    return [apps, { head: "무실점", of: (r) => String(r.cleanSheets), strong: true }];
  }
  if (key === "cards") {
    return [
      apps,
      { head: "경고", of: (r) => String(r.yellows), strong: false },
      { head: "퇴장", of: (r) => String(r.reds), strong: false },
      { head: "점수", of: (r) => String(r.value), strong: true },
    ];
  }
  return [
    apps,
    { head: "득점", of: (r) => String(r.goals), strong: key === "goals" },
    { head: "도움", of: (r) => String(r.assists), strong: key === "assists" },
    // 평점은 문턱을 넘은 선수만 서는 표라 다른 축에서는 기록 없음이 있을 수 있다
    {
      head: "평점",
      of: (r) => (r.rating === null ? "—" : r.rating.toFixed(2)),
      strong: key === "rating",
    },
  ];
}

/**
 * 개인 순위 — 축을 하나 골라 상위 열 명을 본다.
 *
 * 시즌 끝에만 서던 시상을 시즌 중에 미리 읽는 자리다
 * (docs/data/competition.md §2 「개인 순위」). ⚠️ 대항전은 시즌 기록이 대회별로
 * 갈리지 않아 개인 순위가 서지 않고 팀 열만 선다.
 */
function LeadersSection({ competition }: { competition: Competition }) {
  const leaders = competition.leaders;
  const boards = leaders?.players ?? [];
  const [pickedKey, setPickedKey] = useState<LeaderBoard["key"] | null>(null);
  const [ownerId, setOwnerId] = useState(competition.id);
  if (ownerId !== competition.id) {
    setOwnerId(competition.id);
    setPickedKey(null);
  }
  if (!leaders) return null;
  const board = boards.find((b) => b.key === pickedKey) ?? boards[0];
  const columns = board ? leaderColumns(board.key) : [];
  return (
    <>
      {board && (
        <>
          <div className="section-title">개인 순위</div>
          <PillPicker
            value={board.key}
            options={boards.map((b) => ({ value: b.key, label: leaderboardTitle(b.key) }))}
            onPick={setPickedKey}
            label="개인 순위 항목"
            testId="leader-key"
          />
          <table data-testid="leaderboard">
            <thead>
              <tr>
                <th>#</th>
                <th>선수</th>
                <th>팀</th>
                {columns.map((c) => (
                  <th key={c.head}>{c.head}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {board.rows.map((row, i) => (
                <tr key={row.gamePlayerId} className={row.ours ? "me" : ""}>
                  <td>{i + 1}</td>
                  <td className="team-cell">
                    <PlayerName id={row.gamePlayerId} name={row.playerName} />
                  </td>
                  <td className="dim-cell">{row.teamShortName}</td>
                  {columns.map((c) => (
                    <td key={c.head}>{c.strong ? <b>{c.of(row)}</b> : c.of(row)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {leaders.teams.length > 0 && (
        <>
          <div className="section-title">팀 통계</div>
          <table data-testid="team-stats">
            <thead>
              <tr>
                <th>#</th>
                <th>팀</th>
                <th>경기</th>
                <th>득점</th>
                <th>실점</th>
                <th>무실점</th>
                <th>슛</th>
                <th>xG</th>
              </tr>
            </thead>
            <tbody>
              {leaders.teams.map((t, i) => (
                <tr key={t.teamId} className={t.ours ? "me" : ""}>
                  <td>{i + 1}</td>
                  <td className="team-cell">{t.name}</td>
                  <td>{t.played}</td>
                  <td>{t.goalsFor}</td>
                  <td>{t.goalsAgainst}</td>
                  <td>{t.cleanSheets}</td>
                  <td>{t.shots}</td>
                  <td>{t.xg.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
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

/**
 * 다음 경기 한 칸 — **무엇의 다음인지는 부르는 자리가 정한다**(위 `nextMatch`).
 *
 * 경기 중에는 달력 대신 이것만 본다: 90분 안에 감독이 일정에서 궁금한 것은
 * 하나뿐이라(이 경기가 끝나면 언제 누구인가) 달력을 통째로 세우면 그 한 줄을
 * 찾으러 스크롤해야 한다.
 *
 * **며칠 남았는지를 크게 적는다** — 체력이 자리마다 다르게 깎이고 회복이 며칠에
 * 걸리므로(match.md §3) "사흘 뒤"는 곧 로테이션 판단이다. 날짜만 적으면
 * 감독이 오늘 날짜와 빼서 세야 한다.
 */
function NextFixture({ next }: { next: NextMatch }) {
  const venue = venueLabel(next.venue);
  return (
    <div className="next-fixture" data-testid="next-fixture">
      <span className="nf-when">
        <b>{next.inDays === 0 ? "오늘" : `${next.inDays}일 뒤`}</b>
        <i>
          {next.date} {next.time}
        </i>
      </span>
      <span className="nf-what">
        <b>
          <em className={`nf-venue ${next.venue}`}>{venue}</em> {next.opponent}
        </b>
        <i>{next.label}</i>
      </span>
    </div>
  );
}

/**
 * 경기 전 상대 분석 — **다음 경기 카드 아래에 접혀 있다** (match.md §1.8 · §8).
 *
 * 접혀 있는 이유는 이 화면에 온 이유가 순위표이기 때문이고, 그래도 **결장 수와
 * 지점 수는 접힌 줄에 선다** — 펼칠 이유가 카드 밖에 있으면 감독은 펼치지 않는다.
 *
 * 문장은 전부 코어가 만든 것을 그대로 세운다. 지점의 유불리는 뷰가 이미 우리 편
 * 기준으로 접어(`ours`) 오므로 화면이 편을 다시 따지지 않는다.
 */
function MatchPreviewPanel({ preview }: { preview: MatchPreview }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mp-wrap">
      <button
        className={`mp-btn${open ? " open" : ""}`}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="match-preview-toggle"
      >
        <span>상대 분석</span>
        {preview.absent.length > 0 && <i className="mp-chip">결장 {preview.absent.length}</i>}
        {preview.keyPoints.length > 0 && <i className="mp-chip">지점 {preview.keyPoints.length}</i>}
        <IconChevron size={12} />
      </button>
      {open && (
        <div className="mp-body" data-testid="match-preview">
          <div className="mp-section">
            <div className="mp-title">
              예상 XI
              <i className="mp-basis">
                {preview.basis === null
                  ? "직전 경기 없음 — 배치에서 세운 추정"
                  : `직전 ${preview.basis.date.slice(5)} ${preview.basis.label} 선발`}
                {preview.guessed > 0 && ` · 추정 ${preview.guessed}자리`}
              </i>
            </div>
            <div className="mp-xi">
              {preview.expectedXI.map((p) => (
                <span
                  className={`mp-p${preview.guessed > 0 && !p.carried ? " guessed" : ""}`}
                  key={p.id}
                >
                  <b>
                    <PlayerName id={p.id} name={p.name} />
                  </b>
                  <i>{p.position}</i>
                </span>
              ))}
            </div>
          </div>

          {preview.absent.length > 0 && (
            <div className="mp-section">
              <div className="mp-title">결장</div>
              <div className="mp-out">
                {preview.absent.map((a, i) => (
                  <span className={`mp-p out-${a.reason}`} key={i}>
                    <b>
                      <PlayerName id={a.id} name={a.name} />
                    </b>
                    <i>{a.note}</i>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="mp-section">
            <div className="mp-title">
              상대 전술<i className="mp-basis">{preview.shape.formation}</i>
            </div>
            <div className="mp-axes">
              {TACTIC_AXES.map((axis) => (
                <span className="mp-axis" key={axis.key}>
                  <i>{axis.brief}</i>
                  <b>{tacticWord(axis.key, preview.shape[axis.key])}</b>
                </span>
              ))}
            </div>
          </div>

          {preview.keyPoints.length > 0 && (
            <div className="mp-section">
              <div className="mp-title">읽어 낸 지점</div>
              <div className="mp-points">
                {preview.keyPoints.map((k, i) => (
                  <div
                    className={`mp-point${k.ours === null ? "" : k.ours ? " ours" : " theirs"}`}
                    key={i}
                  >
                    {k.text}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 최근 결과 한 줄 — 뷰가 주는 조각(대회·양 팀·스코어·승부차기·우리 편·승패)을
 * 화면이 잇는다. 스코어는 가운데 한 칸에 세워 줄끼리 세로로 맞고, 우리 편 이름만
 * 진하며, 이겼는지는 **색**이 말한다. 승부차기는 스코어를 바꾸지 않고 한 톤 낮춰
 * 옆에 선다 (docs/data/competition.md §6).
 *
 * 중립 경기는 뷰가 우리가 어느 쪽이었는지 말하지 않으므로 어느 이름도 진해지지
 * 않는다 — 스코어로 짐작해 진하게 만들면 그게 곧 화면이 장부를 되쪼는 짓이다.
 */
function RecentResultLine({ r }: { r: RecentResult }) {
  const side = (which: "home" | "away") => (r.venue === which ? "recent-us" : undefined);
  return (
    <div className={`recent-line recent-${r.outcome}`}>
      <i className="recent-label">{r.label}</i>
      <span className={`recent-team recent-home ${side("home") ?? ""}`}>{r.home}</span>
      <b className="recent-score">
        {r.homeGoals}-{r.awayGoals}
      </b>
      <span className={`recent-team recent-away ${side("away") ?? ""}`}>{r.away}</span>
      {/* 승부차기가 없어도 **칸은 낸다** — 줄이 격자를 나눠 쓰는 구조라 한 줄이
          네 칸만 채우면 다음 줄이 한 칸씩 밀려 스코어가 어긋난다 */}
      <i className="recent-pens">
        {r.penalties ? `승부차기 ${r.penalties.home}-${r.penalties.away}` : ""}
      </i>
    </div>
  );
}

/**
 * 시상의 근거 한 줄 — **수치는 코어가 내고 문장은 여기서 잇는다** (overview.md §5).
 * 어느 칸이 그 상의 근거인가는 코드가 정한다 (docs/simulation/season.md §6).
 */
function awardFigure(a: SeasonAwardRow): string {
  const apps = `${a.apps}경기`;
  const rating = a.rating === undefined ? null : `평점 ${a.rating.toFixed(2)}`;
  switch (a.code) {
    case "top-scorer":
      return `${a.goals}골 · ${apps}`;
    case "top-assister":
      return `${a.assists}도움 · ${apps}`;
    case "young-player":
      return [a.age === undefined ? null : `${a.age}세`, rating, apps].filter(Boolean).join(" · ");
    default:
      return [rating, apps].filter(Boolean).join(" · ");
  }
}

/**
 * 그 시즌의 최종 순위표 — **읽는 값이다.** 누를 수 있는 것은 위의 시즌 칩뿐이라
 * 표는 호버도 커서도 갖지 않는다.
 *
 * ⚠️ **이관된 행은 순서와 팀만 안다** (docs/data/game-state.md §3.3). 승점 칸에 0을
 * 채우면 없는 사실이 생기므로, 한 행도 성적을 모르면 숫자 칸 자체를 세우지 않고
 * 섞여 있으면 그 행만 비운다.
 */
function SeasonTable({ table }: { table: PastSeason["table"] }) {
  // 승점·득실을 아는 행이 하나라도 있어야 숫자 칸이 뜻을 갖는다
  const detailed = table.some((r) => r.record !== null);
  return (
    <table data-testid="season-table">
      <thead>
        <tr>
          <th>#</th>
          <th>팀</th>
          {detailed && (
            <>
              <th>경기</th>
              <th>승</th>
              <th>무</th>
              <th>패</th>
              <th>득실</th>
              <th>승점</th>
            </>
          )}
        </tr>
      </thead>
      <tbody>
        {table.map((row) => (
          <tr key={row.teamId} className={row.ours ? "me" : ""}>
            <td>{row.position}</td>
            <td className="team-cell">{row.name}</td>
            {detailed && row.record && (
              <>
                <td>{row.record.played}</td>
                <td>{row.record.wins}</td>
                <td>{row.record.draws}</td>
                <td>{row.record.losses}</td>
                <td>{row.record.goalDiff > 0 ? `+${row.record.goalDiff}` : row.record.goalDiff}</td>
                <td>
                  <b>{row.record.points}</b>
                </td>
              </>
            )}
            {detailed && !row.record && <td className="season-unknown" colSpan={6} />}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * 역대 — **시즌을 고르면 그 시즌이 선다** (docs/overview.md §5 · season.md §6).
 *
 * 우승 횟수는 카탈로그 시드와 게임 안의 우승을 더한 것이고, 시드가 없는 구단은
 * 조각 자체가 없다 — **없는 것은 0회가 아니라 모르는 것이다** (docs/data/team.md §1).
 */
function HistorySection({ competition }: { competition: Competition }) {
  const seasons = competition.pastSeasons;
  const honours = competition.honours;
  const [picked, setPicked] = useState<number | null>(null);
  // 대회를 바꾸면 선택을 놓아 그 대회의 가장 최근 시즌으로 돌아간다
  const [ownerId, setOwnerId] = useState(competition.id);
  if (ownerId !== competition.id) {
    setOwnerId(competition.id);
    setPicked(null);
  }
  // 지나간 시즌도 역대 우승도 없으면 절이 설 이유가 없다
  if (seasons.length === 0 && honours === null) return null;
  const index = Math.min(picked ?? 0, Math.max(0, seasons.length - 1));
  const season = seasons[index];

  return (
    <>
      <div className="section-title">역대</div>
      {honours && (
        <div className="honours-line" data-testid="competition-honours">
          <b>우승 {honours.count}회</b>
          {honours.won.length > 0 ? (
            <span className="honours-won">
              {honours.won.map((w) => (
                <i key={w.season}>{w.label}</i>
              ))}
            </span>
          ) : (
            honours.lastYear !== null && (
              <span className="honours-last">마지막 {honours.lastYear}</span>
            )
          )}
        </div>
      )}
      {seasons.length > 0 && (
        <div className="season-tabs" data-testid="season-tabs">
          {seasons.map((s, i) => (
            <button
              key={s.season}
              type="button"
              className={i === index ? "active" : ""}
              aria-pressed={i === index}
              onClick={() => setPicked(i)}
              data-testid={`season-tab-${s.season}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      {season && (
        <div data-testid="season-history">
          <div className="season-head">
            {season.champion && (
              <span className={`season-slot${season.champion.ours ? " ours" : ""}`}>
                <i>우승</i>
                <b>{season.champion.name}</b>
              </span>
            )}
            {season.runnerUp && (
              <span className={`season-slot${season.runnerUp.ours ? " ours" : ""}`}>
                <i>준우승</i>
                <b>{season.runnerUp.name}</b>
              </span>
            )}
            {/* 우승·준우승 칸이 이미 우리를 말했으면 같은 사실을 두 번 세우지 않는다 */}
            {season.ourPosition !== null && !season.champion?.ours && !season.runnerUp?.ours && (
              <span className="season-slot ours">
                <i>우리</i>
                <b>{season.ourPosition}위</b>
              </span>
            )}
          </div>
          {season.table.length > 0 && <SeasonTable table={season.table} />}
          {season.awards.length > 0 && (
            <div className="season-awards" data-testid="season-awards">
              {season.awards.map((a) => (
                <div className="season-award" key={a.code}>
                  <i>{awardTitle(a.code)}</i>
                  <b>{a.playerName}</b>
                  <span>{a.teamShort}</span>
                  <em>{awardFigure(a)}</em>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function CompetitionsView({
  competitions,
  inMatch = false,
}: {
  competitions: OfficeViews["competitions"];
  /** 경기 중인가 — 카드가 무엇을 세우는지가 여기서 갈린다 (아래 `nextMatch`) */
  inMatch?: boolean;
}) {
  const list = competitions.list;
  const [activeId, setActiveId] = useState(list[0]?.id ?? "");
  const active = list.find((c) => c.id === activeId) ?? list[0];
  /**
   * 맨 아래 카드 — **평시엔 보고 있는 대회의 경기, 경기 중엔 팀의 다음 경기**다.
   *
   * 대회 탭은 그 대회를 읽으러 온 자리라 순위표·일정 아래에 다른 대회의 경기가
   * 서면 안 되고(overview §5), 90분 안에 궁금한 것은 반대로 이 경기가 끝난 뒤
   * 언제 누구인가다(match.md §8).
   */
  const nextMatch = inMatch ? competitions.nextMatch : (active?.nextMatch ?? null);

  return (
    <div data-testid="view-competitions">
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
              {/* 국내 컵은 순위표가 없다 — 순위 대신 어디까지 갔는지를 말한다 */}
              {active.standings.length === 0
                ? cupProgressLabel(active.cupProgress)
                : active.userPosition > 0
                  ? `${active.europe ? "리그 페이즈 " : ""}${active.userPosition}위`
                  : "순위 없음"}
              {/* 추첨 전이면 "남은 경기 없음"이 아니라 아직 시작을 안 한 것이다 */}
              {active.nextMatch
                ? ` · 다음 ${active.nextMatch.date} ${venueLabel(active.nextMatch.venue)} vs ${active.nextMatch.opponent}`
                : active.bracket.length === 0 && active.standings.length === 0
                  ? ""
                  : " · 남은 경기 없음"}
            </span>
          </div>

          {/* 순수 녹아웃(국내 컵)엔 순위표가 없다 — 브래킷이 그 자리를 대신한다 */}
          {active.standings.length > 0 && (
            <>
              <div className="section-title">순위</div>
              <StandingsTable competition={active} />
            </>
          )}

          {active.bracket.length > 0 && <BracketSection bracket={active.bracket} />}
          {active.bracket.length === 0 && active.standings.length === 0 && (
            <div className="empty">대진 추첨을 기다리는 중입니다</div>
          )}

          {/* 순수 녹아웃은 브래킷이 곧 일정표다 — 같은 대진을 두 번 늘어놓지 않는다.
              리그·대항전은 브래킷이 못 담는 라운드(리그 페이즈)가 있어 따로 둔다 */}
          {active.standings.length > 0 && (
            <>
              <div className="section-title">일정</div>
              <RoundFixtures competition={active} />
            </>
          )}

          {/* 개인 순위·팀 열은 순위표와 같은 표 계열이라 일정 다음에 이어 선다 */}
          <LeadersSection competition={active} />

          {competitions.recentResults.length > 0 && (
            <>
              <div className="section-title">최근 결과</div>
              {/* 다섯 줄이 **한 격자**를 나눠 쓴다 — 줄마다 격자를 세우면 이름 길이에
                  따라 스코어 칸이 줄마다 어긋난다 */}
              <div className="recent-list">
                {competitions.recentResults.map((r, i) => (
                  <RecentResultLine r={r} key={i} />
                ))}
              </div>
            </>
          )}

          {/* 역대는 지나간 시즌의 자리다 — 이번 시즌을 다 읽은 뒤에 선다 */}
          <HistorySection competition={active} />
        </>
      )}

      {/* 다음 경기는 **맨 아래**다 — 이 화면에 온 이유는 순위표이고, 다음 상대는
          다 읽고 나서 "그래서 언제 누구지"로 이어지는 자리다 */}
      {nextMatch && (
        <>
          <div className="section-title">다음 경기</div>
          <NextFixture next={nextMatch} />
          {/* 상대 분석은 그 경기의 것이다 — 경기 중에는 코어가 빈손을 낸다 */}
          {competitions.preview && competitions.preview.matchId === nextMatch.matchId && (
            <MatchPreviewPanel preview={competitions.preview} />
          )}
        </>
      )}
    </div>
  );
}

/**
 * 컵에서 우리가 어디까지 갔는가 — 순위표가 없는 대회의 "현재 위치".
 * 단계와 결말은 뷰가 내고(브래킷 해석은 코어의 몫), 화면은 문장만 잇는다.
 */
function cupProgressLabel({ stage, outcome }: Competition["cupProgress"]): string {
  switch (outcome) {
    case "undrawn":
      return "추첨 전";
    case "out":
      return "탈락";
    case "champion":
      return "우승";
    case "eliminated":
      return stage ? `${stage} 탈락` : "탈락";
    case "through":
      return stage ? `${stage} 진출` : "진출";
  }
}

/** 녹아웃 브래킷 — 단계별 대진 (2차전 합계는 엔진이 계산해 넘긴다) */
function BracketSection({ bracket }: { bracket: Competition["bracket"] }) {
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
              <span className="euro-when">{tie.date.slice(5)}</span>
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
