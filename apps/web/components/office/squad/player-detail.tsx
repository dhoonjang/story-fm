"use client";

import {
  AXIS_GROUPS,
  AXIS_GROUP_KO,
  AXIS_KO,
  defaultRoleOf,
  footLabel,
  isNaturalAt,
  milestoneTitle,
  physiqueLabel,
  rolesFor,
} from "@story-fm/domain";
import { moodSentence } from "@/lib/mood";
import { FitGauge, FormArrow, RatingTrend, StatusBadges } from "./marks";
import type { SquadRow } from "./types";

/** 상세에서 보여줄 축 묶음 순서 — 라벨·구성은 domain(AXIS_GROUPS)이 단일 소스 */
const AXIS_GROUP_ORDER = ["physical", "technical", "mental", "goalkeeping"] as const;

/**
 * 두 발 숙련도를 **발 아이콘 두 개**로 — 숫자 두 개보다 한눈에 읽힌다.
 * 진하기가 곧 등급이고(1~5), 더 잘 쓰는 발만 색이 붙는다. 정확한 숫자는 툴팁에.
 */
function FootMarks({ foot }: { foot: SquadRow["foot"] }) {
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
 * 추정 폭을 말로 — 같은 "잠재력 78~86"도 확신의 정도가 다르다.
 * 폭이 어느 정도부터 무슨 낱말인지는 **스카우팅이 정한다**(`potentialConfidence`).
 * 화면은 그 낱말을 받아 문장에 끼울 뿐, 임계값을 다시 재지 않는다.
 */
function potentialHint(band: SquadRow["potential"]): string {
  if (!band) return "성장 여력을 짐작할 근거가 없습니다";
  return `추정 폭 ±${band.margin} — ${band.confidence}. 함께 뛴 경기가 쌓이면 좁아집니다`;
}

/** 선택한 선수 상세 — 그 자리 적응도와 능력치 16축 */
export function PlayerDetail({
  p,
  slotCode,
  action,
  onRole,
  roleId,
}: {
  p: SquadRow;
  slotCode: string | null;
  /** 이 선수에게 거는 조작 — 1·2군 이동. **선수 옆에 둔다** */
  action?: React.ReactNode;
  /** 세부 역할 선택 (배치가 없거나 경기 중이면 없다) */
  onRole?: (roleId: string) => void;
  /**
   * 지금 켜져 있는 역할 — **아직 저장되지 않은 선택까지 포함한다.**
   * `p.roleId`만 보면 서버 왕복이 끝나기 전까지 방금 고른 역할이 안 켜져서,
   * 눌렀는데 아무 일도 일어나지 않은 것처럼 보인다.
   */
  roleId?: string | null;
}) {
  const axes = p as unknown as Record<string, number>;
  /**
   * 역할이 성립하는 자리 — 고른 칩이면 그 자리, 아니면 이 행이 지금 선 자리.
   * `p`는 명단 사본이라 `assignedPosition`이 곧 판 위의 좌표에서 읽은 코드고,
   * 판에 없으면 null이다. **자리가 없으면 역할도 없다** (player.md §3.1).
   */
  const rolePosition = slotCode ?? p.assignedPosition;
  /**
   * 목록도 값도 **서버 행이 아니라 지금 전술판의 자리**에서 읽는다. 끌어 옮긴
   * 직후에는 `slotCode`만 먼저 바뀌고 `p.roleOptions`는 자동 저장 응답 전까지
   * 이전 자리의 목록이라, 그대로 그리면 포지션 칩은 CM인데 역할은 DM(앵커·하프백)인
   * 모순이 생긴다.
   */
  const roleOptions = rolePosition ? rolesFor(rolePosition) : p.roleOptions;
  const requestedRole = roleId ?? p.roleId;
  const activeRole = roleOptions.some((r) => r.id === requestedRole)
    ? requestedRole
    : rolePosition
      ? defaultRoleOf(rolePosition)
      : null;
  /**
   * 포지션 칩 — 보유 목록에 **지금 맡은 자리**를 합친다.
   *
   * 적응도는 `positionProficiency`가 결정적으로 내는 값이라 추정도 안개도
   * 아니다 — 물음표("추정치")를 붙이면 믿어도 되는 숫자에 "믿지 말라"는 뜻을
   * 얹게 된다.
   *
   * `known`은 **선수의 포지션 목록에 있는가**다. 지금 서 있는 자리가 목록에 없을 수
   * 있는데(감독이 생소한 자리에 세웠다) 그걸 "소화 가능"과 같은 색으로 두면
   * 무리한 배치라는 사실이 화면에서 사라진다.
   */
  const chips: Array<{ position: string; isNatural?: boolean; known: boolean }> =
    slotCode && !p.positions.some((x) => x.position === slotCode)
      ? [
          ...p.positions.map((x) => ({ ...x, known: true })),
          { position: slotCode, isNatural: false, known: false },
        ]
      : p.positions.map((x) => ({ ...x, known: true }));
  /**
   * **선호 포지션은 여럿이다.** 주 포지션 자체가 여럿일 수 있고(두 자리를 다 자기
   * 자리로 삼는 선수), 하나여도 좌우 분화(`CB`↔`LCB`↔`RCB`)는 같은 자리다.
   * 판정은 도메인의 `isNaturalAt` 하나가 갖는다 — 화면이 따로 계산하면 대표 자리
   * 하나만 보고 나머지 주 포지션을 "소화 가능"으로 밀어내기 쉽다.
   */
  const preferred = (code: string) => isNaturalAt(p, code);
  /**
   * 커리어 표를 세울까 — **시즌 행이 하나뿐이고 그게 이번 시즌이면 세우지 않는다.**
   * 위 요약 줄의 "시즌 N경기"가 이미 같은 수를 말했고(`seasonApps`는 이번 시즌 이
   * 팀의 것이다), 같은 값을 표로 한 번 더 그리면 상세가 요약의 복사본이 된다.
   * 뛴 적이 없으면(개막 전·갓 온 유스) 행 자체가 없어 표도 없다 — 빈 표를 자리
   * 잡아 두면 줄이 길어지고 그 폭이 명단의 열 계산에 얹힌다.
   */
  const careerRows = p.career.seasons;
  const showCareer = careerRows.length > 1 || (careerRows.length === 1 && p.seasonApps === 0);
  return (
    <div className="player-detail" data-testid="player-detail">
      {/* 지금 심경 한 줄 — 아래 숫자들이 왜 그런지 */}
      <p className="pd-mood" data-testid="player-mood">
        {moodSentence(p.mood)}
      </p>

      {/* 상태 요약 — 이름·나이·OVR은 바로 위 행과 겹치므로 표에 없는 것만, 박스로
          쪼개지 않고 한 줄로 훑는다 */}
      <div className="pd-summary">
        {/**
         * **이 선수를 얼마나 아는가** — 아래 열여섯 숫자 전부에 걸리는 단서다.
         * 명단의 `±N`은 종합값 하나에 붙지만, 상세는 축을 펼쳐 놓은 자리라
         * "이 화면의 숫자들이 어느 정도 정확한가"를 먼저 밝혀야 한다.
         * 정확히 아는 선수(대부분)에게는 아무것도 그리지 않는다.
         */}
        {p.observation.margin > 0 && (
          <span title={`아래 능력치는 ±${p.observation.margin} 안에서만 정확합니다`}>
            정보{" "}
            <b>
              {p.observation.label} ±{p.observation.margin}
            </b>
          </span>
        )}
        {/* 잠재력은 숫자 하나가 아니라 **구간**이다 — 우리 선수도 단정할 수 없다.
            폭이 좁을수록 확신이 크고, 근거가 없으면 "미지" (scouting.ts §잠재력) */}
        <span title={potentialHint(p.potential)}>
          잠재력 <b>{p.potential ? `${p.potential.low}~${p.potential.high}` : "미지"}</b>
        </span>
        {/* 체력은 여기 두지 않는다 — 바로 위 명단 행에 바가 있고, 왜 그런지는
            맨 위 심경 한 줄이 말한다. 같은 값을 두 번 쓰면 상세가 표의 복사본이 된다 */}
        <span>
          폼{" "}
          <b>
            <FormArrow p={p} />
          </b>
        </span>
        {p.role !== "스쿼드" && (
          <span>
            적응{" "}
            <b>
              <FitGauge value={p.adaptation} />
            </b>
          </span>
        )}
        {/* 임대 — **그 구단의 사실만** 적는다. 아래 시즌 기록도 그 구단 장부라
            어디서 낸 숫자인지가 이 줄 옆에 서 있어야 읽힌다. 무엇을 하라는 말은
            여기 붙지 않는다 (근거 코드가 뜻하는 사실만 옮긴다) */}
        {p.loan !== null && (
          <span title={`${p.loan.team} 임대 — ${p.loan.until} 복귀`}>
            임대{" "}
            <b>
              {p.loan.team} ~{p.loan.until}
            </b>
            {p.loan.benchRun > 0 && ` · 최근 ${p.loan.benchRun}경기 명단 밖`}
            {p.loan.growth > 0 && ` · 임대 이후 성장 +${p.loan.growth}`}
          </span>
        )}
        {/* **없는 기록은 적지 않는다.** 개막 전에는 스물일곱 명 전원이 "0경기 ·
            평점 — · 최근 기록 없음"이라, 빈 값을 자리 잡아 두면 줄이 그만큼 길어지고
            그 폭이 표의 열 계산에 얹혀 행을 펼칠 때마다 명단이 흔들렸다 */}
        {p.seasonApps > 0 && (
          <>
            <span>
              시즌{" "}
              <b>
                {p.seasonApps}경기 {p.seasonGoals}골 {p.seasonAssists}도움
              </b>
            </span>
            {typeof p.seasonRating === "number" && (
              <span>
                평점 <b>{p.seasonRating.toFixed(2)}</b>
              </span>
            )}
            {/* 폼의 시간 축 — 최근 경기가 오른쪽 */}
            {p.recentRatings.length > 0 && (
              <span className="pd-trend">
                최근 <RatingTrend ratings={p.recentRatings} />
              </span>
            )}
          </>
        )}
        {p.height !== null && p.weight !== null && (
          <span>
            체격 <b>{physiqueLabel(p.height, p.weight)}</b>
          </span>
        )}
        <FootMarks foot={p.foot} />
        {p.contractUntil && (
          <span>
            계약 <b>{p.contractUntil}</b>
          </span>
        )}
        <StatusBadges p={p} />
        {/* 조작은 대상 옆에 — 명단 머리글에 두면 선수를 고를 때마다 버튼이
            나타나 정원 숫자를 가운데로 밀어내 머리글이 들썩이고, 무엇보다
            "누구를" 옮기는 버튼인지가 화면상 멀어진다 */}
        {action && <span className="pd-action">{action}</span>}
      </div>

      <div className="pd-body">
        {/* 소화 포지션 — **선호와 가능만** 말한다. 자리마다 숫자를 세우면 "포지션
            적응도"라는 두 번째 축이 화면에 되살아난다. 어디에 세울지는 전술판의
            자리 전력과 명단의 적응도가 답한다 */}
        {/* 포지션·역할은 **능력치 위에 가로로** 눕는다. 오른쪽 좁은 열에 세워 두면
            역할 이름(인버티드 윙백)이 한 줄에 하나씩 쌓여 상세가 세로로 길어지고,
            그 열이 요구하는 폭이 표의 열 계산에까지 얹혀 행을 펼칠 때마다 명단이
            흔들렸다 */}
        <div className="pd-side">
          {/* 포지션은 **읽는 것**이고 역할은 **고르는 것**이다. 둘 다 알약 모양이던
              때는 눌러도 아무 일이 없는 포지션과 눌리는 역할이 똑같이 생겨서,
              감독이 CB를 눌러 보고 고장인 줄 알았다. 그래서 포지션은 테두리를
              벗겨 글자로 눕히고, 역할만 눌리는 물건의 생김새를 갖는다 */}
          <div className="pd-positions">
            <span className="pd-axis-group-name">포지션</span>
            <div className="pd-pos-list">
              {chips.map((x) => (
                <span
                  className={
                    `pd-pos` +
                    (x.position === slotCode ? " here" : "") +
                    (preferred(x.position) ? " natural" : x.known ? "" : " foreign")
                  }
                  key={x.position}
                  title={
                    (preferred(x.position)
                      ? "선호 포지션"
                      : x.known
                        ? "소화 가능"
                        : "익숙하지 않은 자리") +
                    (x.position === slotCode ? " · 지금 맡고 있는 자리" : "")
                  }
                >
                  {x.position}
                </span>
              ))}
            </div>
          </div>

          {/* 세부 역할 — **자리 위에 얹히는 축**이다. 같은 센터백이라도 노넌센스와
            볼 플레잉은 요구 역량이 다르고, 그 차이는 옆의 자리 전력이 곧바로 답한다.
            자리를 옮기면 목록이 통째로 바뀐다 (그 자리에 없는 역할은 고를 수 없다) */}
          {roleOptions.length > 1 && (
            <div className="pd-roles">
              <span className="pd-axis-group-name">역할</span>
              <div className="pd-role-list">
                {/**
                 * 알약은 **그 역할이 무슨 일을 하는지만** 말한다 (player.md §7.2).
                 * 전환 대가를 알약마다 적으면 "이 선수에게 무엇을 시킬까"가
                 * 가장 싼 역할 고르기로 바뀐다 — 적응도는 하루면 기준이 다시 잡힌다.
                 */}
                {roleOptions.map((r) => (
                  <button
                    className={`pd-role${r.id === activeRole ? " on" : ""}`}
                    key={r.id}
                    type="button"
                    title={r.desc}
                    disabled={!onRole}
                    onClick={(e) => {
                      // 상세는 행 안에 있다 — 막지 않으면 행 토글로 새어 나가 접힌다
                      e.stopPropagation();
                      onRole?.(r.id);
                    }}
                  >
                    {r.ko}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 능력치 16축 — 묶음별 한 줄, 값은 세로로 줄 맞춰 훑기 쉽게 */}
        <div className="pd-axis-groups">
          {AXIS_GROUP_ORDER.map((group) => (
            <div className="pd-axis-group" key={group}>
              <span className="pd-axis-group-name">{AXIS_GROUP_KO[group]}</span>
              <div className="pd-axes">
                {AXIS_GROUPS[group].map((a) => (
                  <span className="pd-axis" key={a}>
                    <span className="pd-axis-label">{AXIS_KO[a]}</span>
                    <b>{axes[a] ?? 0}</b>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 커리어 — 시즌 × 팀의 표와 그 옆의 마일스톤. **머리글 줄이 아니라 제
          블록이다**: 요약 줄은 한 줄로 훑는 자리라 격자가 낄 자리가 없다.
          기록이 없으면 아무것도 세우지 않는다 (위 `showCareer` 주석) */}
      {(showCareer || p.milestones.length > 0) && (
        <div className="pd-career">
          {showCareer && (
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
                {careerRows.map((row) => (
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
                    {p.career.totals.apps}
                    <ReserveMark value={p.career.totals.reserveApps} />
                  </td>
                  <td>
                    {p.career.totals.goals}
                    <ReserveMark value={p.career.totals.reserveGoals} />
                  </td>
                  <td>{p.career.totals.assists}</td>
                  <td>
                    {p.career.totals.rating === null ? "—" : p.career.totals.rating.toFixed(2)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
          {/* 마일스톤 — 코어가 내는 것은 코드와 수치뿐이고 라벨은 domain이 만든다
              (`milestoneTitle`). 남의 팀 선수에겐 장부가 없지만 명단은 우리 선수뿐이다 */}
          {p.milestones.length > 0 && (
            <div className="pd-milestones">
              <span className="pd-axis-group-name">마일스톤</span>
              <ul>
                {p.milestones.map((m) => (
                  <li key={`${m.date}-${m.code}-${m.value}`}>
                    <b>{milestoneTitle(m.code, m.value)}</b>
                    <i>{m.date}</i>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {p.instruction && <p className="pd-foot">개인 지시 “{p.instruction}”</p>}
    </div>
  );
}
