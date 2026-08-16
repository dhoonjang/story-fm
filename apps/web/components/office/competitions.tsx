"use client";

import { useState } from "react";
import type { OfficeViews } from "@story-fm/engine";

// ── 대회 — 대회별 탭 · 순위표 · 라운드별 일정 ──────────────
type Competition = OfficeViews["competitions"]["list"][number];

/** 순위표 — 리그는 그대로, 대항전은 통과 경계선을 긋는다 */
function StandingsTable({ competition, teamName }: { competition: Competition; teamName: string }) {
  // 순위표를 갖는 대회는 리그와 대항전 리그 페이즈뿐이다 (국내 컵은 브래킷을 본다)
  const europe = competition.europe;
  const zones = competition.zones;
  // 순위 → 그 순위가 속한 구역 (없으면 아무 뜻도 없는 자리)
  const zoneAt = (rank: number) => zones.find((z) => rank <= z.through) ?? null;
  return (
    <table data-testid={europe ? "europe-standings" : "standings"}>
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
        {competition.standings.map((row, i) => {
          const zone = zoneAt(i + 1);
          return (
            <tr
              key={row.teamId}
              className={[
                row.name === teamName ? "me" : "",
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
              <td>{row.played}</td>
              <td>{row.wins}</td>
              <td>{row.draws}</td>
              <td>{row.losses}</td>
              <td>{row.goalDiff > 0 ? `+${row.goalDiff}` : row.goalDiff}</td>
              <td>
                <b>{row.points}</b>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
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
 * 다음 경기 한 칸 — **경기 중에는 달력 대신 이것만 본다.**
 *
 * 90분 안에 감독이 일정에서 궁금한 것은 하나뿐이다: 이 경기가 끝나면 다음은
 * 언제 누구인가. 달력을 통째로 세우면 그 한 줄을 찾으러 스크롤해야 한다.
 *
 * **며칠 남았는지를 크게 적는다** — 체력이 자리마다 다르게 깎이고 회복이 며칠에
 * 걸리므로(match-sim §2.1.1) "사흘 뒤"는 곧 로테이션 판단이다. 날짜만 적으면
 * 감독이 오늘 날짜와 빼서 세야 한다.
 */
function NextFixture({ next }: { next: OfficeViews["competitions"]["nextMatch"] }) {
  if (!next) return null;
  const venue = next.venue === "home" ? "홈" : next.venue === "away" ? "원정" : "중립";
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

export function CompetitionsView({
  competitions,
  teamName,
}: {
  competitions: OfficeViews["competitions"];
  teamName: string;
}) {
  const list = competitions.list;
  const [activeId, setActiveId] = useState(list[0]?.id ?? "");
  const active = list.find((c) => c.id === activeId) ?? list[0];

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
                ? cupProgress(active)
                : active.userPosition > 0
                  ? `${active.europe ? "리그 페이즈 " : ""}${active.userPosition}위`
                  : "순위 없음"}
              {/* 추첨 전이면 "남은 경기 없음"이 아니라 아직 시작을 안 한 것이다 */}
              {active.next
                ? ` · 다음 ${active.next}`
                : active.bracket.length === 0 && active.standings.length === 0
                  ? ""
                  : " · 남은 경기 없음"}
            </span>
          </div>

          {/* 순수 녹아웃(국내 컵)엔 순위표가 없다 — 브래킷이 그 자리를 대신한다 */}
          {active.standings.length > 0 && (
            <>
              <div className="section-title">순위</div>
              <StandingsTable competition={active} teamName={teamName} />
              <ZoneLegend zones={active.zones} />
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

          {competitions.recentResults.length > 0 && (
            <>
              <div className="section-title">최근 결과</div>
              {competitions.recentResults.map((r, i) => (
                <div className="recent-line" key={i}>
                  {r}
                </div>
              ))}
            </>
          )}
        </>
      )}

      {/* 다음 경기는 **맨 아래**다 — 이 화면에 온 이유는 순위표이고, 다음 상대는
          다 읽고 나서 "그래서 언제 누구지"로 이어지는 자리다 */}
      {competitions.nextMatch && (
        <>
          <div className="section-title">다음 경기</div>
          <NextFixture next={competitions.nextMatch} />
        </>
      )}
    </div>
  );
}

/**
 * 컵에서 우리가 어디까지 갔는가 — 순위표가 없는 대회의 "현재 위치".
 * 브래킷에서 우리 대진이 마지막으로 나온 단계를 읽는다.
 */
function cupProgress(competition: Competition): string {
  const ours = competition.bracket.filter((stage) => stage.ties.some((t) => t.ours));
  const last = ours[ours.length - 1];
  if (!last) return competition.bracket.length === 0 ? "추첨 전" : "탈락";
  const tie = last.ties.find((t) => t.ours)!;
  if (tie.won === false) return `${last.label} 탈락`;
  if (tie.won === true && last.stage === "final") return "우승";
  return `${last.label} 진출`;
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
