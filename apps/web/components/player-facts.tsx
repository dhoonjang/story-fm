"use client";

import { AXIS_GROUPS, AXIS_GROUP_KO, AXIS_KO, footLabel, milestoneTitle } from "@story-fm/domain";
import type { Foot } from "@story-fm/domain";
import type { CareerSeasonView, CareerTotalsView, MilestoneView } from "@story-fm/engine";

/**
 * ── 선수 한 사람을 그리는 조각 ───────────────────────────────
 *
 * **명단 상세와 이름을 눌러 여는 카드가 나눠 쓴다** (player.md §9.5). 같은 열여섯
 * 숫자와 같은 커리어 표를 두 곳이 각자 그리면 한쪽만 고쳐지는 날이 오고, 그날부터
 * 같은 선수가 두 화면에서 다르게 보인다.
 *
 * 클래스 이름의 `pd-`는 상세(player-detail)에서 났지만 이제 이 조각들의 것이다 —
 * 스타일은 `styles/office/squad.css` 한 벌이고 두 화면이 같은 규칙을 읽는다.
 */

/** 상세에서 보여줄 축 묶음 순서 — 라벨·구성은 domain(AXIS_GROUPS)이 단일 소스 */
const AXIS_GROUP_ORDER = ["physical", "technical", "mental", "goalkeeping"] as const;

/**
 * 두 발 숙련도를 **발 아이콘 두 개**로 — 숫자 두 개보다 한눈에 읽힌다.
 * 진하기가 곧 등급이고(1~5), 더 잘 쓰는 발만 색이 붙는다. 정확한 숫자는 툴팁에.
 */
export function FootMarks({ foot }: { foot: Foot }) {
  /**
   * 배치는 **(왼 숫자)(왼발)(오른발)(오른 숫자)** — 숫자를 바깥으로 빼면 두 발이
   * 가운데서 마주 보게 되고, 아치가 서로를 향해 굽어 어느 쪽이 어느 발인지가
   * 글자 없이 읽힌다. 숫자를 발 오른쪽에 붙여 두었을 땐 두 아이콘이 같은 방향을
   * 보는 것처럼 보여 매번 헷갈렸다.
   */
  return (
    <span className="foot-marks" title={`${footLabel(foot)} (좌우 분화 자리의 적응도를 가른다)`}>
      <b className={`foot-num w${foot.left}`}>{foot.left}</b>
      {(["L", "R"] as const).map((side) => {
        const rating = side === "L" ? foot.left : foot.right;
        return (
          <span className="foot-pair" key={side}>
            <svg
              /* 색이 곧 등급이다 — 1(빨강) ~ 5(초록). 적응도 게이지와 같은 척도를 쓴다 */
              className={`foot-mark w${rating}`}
              viewBox="0 0 24 34"
              aria-hidden
            >
              {/**
               * 발자국 하나를 좌우 반전해 반대 발로 쓴다 — 엄지발가락과 아치가
               * 방향을 만든다.
               *
               * ⚠️ **원본 도형은 오른발이다.** 발가락이 큰 것(cx 6.6)부터 작은 것
               * (cx 20.8)으로 왼쪽→오른쪽으로 놓여 있는데, 위에서 내려다본 발은
               * 엄지가 **안쪽**을 향한다. 엄지가 왼쪽이면 그 안쪽은 왼편 —
               * 오른발이다.
               */}
              <g transform={side === "L" ? "translate(24,0) scale(-1,1)" : undefined}>
                <path d="M6.2 13.2c4.3-1.7 10-1.3 12.6 1.5 1.9 2 1.5 4.7.3 6.9-1 1.9-2.1 3.3-2.1 5.4 0 3.2-2.2 5.4-5.2 5.4s-5.3-2.2-5.3-5.4c0-2.1.8-3.5 1.3-5.1.6-1.9.3-3.3-1-4.5-1.4-1.2-1.6-3.5-.6-4.2z" />
                <ellipse cx="6.6" cy="7.2" rx="3.1" ry="3.6" />
                <ellipse cx="12.4" cy="5" rx="2.4" ry="2.7" />
                <ellipse cx="17" cy="5.6" rx="2.1" ry="2.4" />
                <ellipse cx="20.8" cy="7.6" rx="1.8" ry="2" />
              </g>
            </svg>
          </span>
        );
      })}
      <b className={`foot-num w${foot.right}`}>{foot.right}</b>
    </span>
  );
}

/**
 * 2군 리그 기록 — 1군 숫자 **옆에 곁들인다.** 더해서 한 칸에 적으면 표의 "출전
 * 38"이 1·2군 혼합값이 되고(season.md §2), 열을 따로 세우면 대부분의 행이 빈
 * 열 둘이 표를 넓힌다. 있을 때만 나타나므로 없는 선수의 표는 그대로 좁다.
 */
function ReserveMark({ value }: { value: number }) {
  if (value <= 0) return null;
  return <i title={`2군 리그 ${value}`}>+{value}</i>;
}

/**
 * 능력치 16축 — 묶음별 한 줄, 값은 세로로 줄 맞춰 훑기 쉽게.
 *
 * `margins`는 **축마다의 오차폭**이다(player.md §9) — 우리 선수는 대개 0이라 아무것도
 * 붙지 않고, 남의 선수는 축마다 다른 폭이 숫자 옆에 선다. 몸과 발(관측형)이 좁고
 * 판단(분석형)이 넓은 그 차이가 곧 "데려와 봐야 아는 선수"라, 폭을 하나로 접어
 * 머리글에만 적으면 그 사실이 화면에서 사라진다.
 */
export function AxisGrid({
  axes,
  margins,
}: {
  axes: Record<string, number>;
  margins?: Record<string, number>;
}) {
  return (
    <div className="pd-axis-groups">
      {AXIS_GROUP_ORDER.map((group) => (
        <div className="pd-axis-group" key={group}>
          <span className="pd-axis-group-name">{AXIS_GROUP_KO[group]}</span>
          <div className="pd-axes">
            {AXIS_GROUPS[group].map((a) => {
              const margin = margins?.[a] ?? 0;
              return (
                <span className="pd-axis" key={a}>
                  <span className="pd-axis-label">{AXIS_KO[a]}</span>
                  <b>
                    {axes[a] ?? 0}
                    {margin > 0 && (
                      <i className="est" title={`이 숫자는 ±${margin} 안에서만 정확합니다`}>
                        ±{margin}
                      </i>
                    )}
                  </b>
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 커리어 — 시즌 × 팀의 표와 그 옆의 마일스톤. 기록이 없으면 아무것도 세우지 않는다.
 *
 * 표를 세울지 말지는 부르는 쪽이 정한다(`showTable`) — 상세는 위 요약 줄이 이미
 * 같은 수를 말했는지를 알고, 카드는 그 판단의 기준이 다르다.
 */
export function CareerBlock({
  seasons,
  totals,
  milestones,
  showTable,
}: {
  seasons: CareerSeasonView[];
  totals: CareerTotalsView;
  milestones: MilestoneView[];
  showTable: boolean;
}) {
  if (!showTable && milestones.length === 0) return null;
  return (
    <div className="pd-career">
      {showTable && (
        <table className="pd-career-table">
          <thead>
            <tr>
              <th>시즌</th>
              <th>팀</th>
              <th>출전</th>
              <th>골</th>
              <th>도움</th>
              <th>평점</th>
            </tr>
          </thead>
          <tbody>
            {/* 시즌 안에 팀을 옮겼으면 **행도 팀별로 갈린다** — 합치면 어느
                셔츠로 몇 경기를 뛰었는지가 사라진다 (player.md §10) */}
            {seasons.map((row) => (
              <tr key={`${row.season}-${row.teamId}`}>
                <td>{row.season}</td>
                <td>{row.team}</td>
                <td>
                  {row.apps}
                  <ReserveMark value={row.reserveApps} />
                </td>
                <td>
                  {row.goals}
                  <ReserveMark value={row.reserveGoals} />
                </td>
                <td>{row.assists}</td>
                <td>{row.rating === null ? "—" : row.rating.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
          {/* 통산은 표의 **마지막 줄**이다 — 같은 열을 쓰므로 시즌 행과 세로로
              바로 견줘진다 (따로 떼어 놓으면 무엇의 합인지가 멀어진다) */}
          <tfoot>
            <tr>
              <th colSpan={2}>통산</th>
              <td>
                {totals.apps}
                <ReserveMark value={totals.reserveApps} />
              </td>
              <td>
                {totals.goals}
                <ReserveMark value={totals.reserveGoals} />
              </td>
              <td>{totals.assists}</td>
              <td>{totals.rating === null ? "—" : totals.rating.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
      )}
      {/* 마일스톤 — 코어가 내는 것은 코드와 수치뿐이고 라벨은 domain이 만든다
          (`milestoneTitle`). 남의 팀 선수에겐 장부가 없어 목록 자체가 비어 있다 */}
      {milestones.length > 0 && (
        <div className="pd-milestones">
          <span className="pd-axis-group-name">마일스톤</span>
          <ul>
            {milestones.map((m) => (
              <li key={`${m.date}-${m.code}-${m.value}`}>
                <b>{milestoneTitle(m.code, m.value)}</b>
                <i>{m.date}</i>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
