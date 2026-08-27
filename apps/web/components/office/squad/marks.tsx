"use client";

import type { CSSProperties } from "react";
import {
  SET_PIECE_ROLES,
  SET_PIECE_ROLE_KO,
  SET_PIECE_ROLE_MARK,
  formatMoney,
  positionProficiency,
  type SetPieceRole,
} from "@story-fm/domain";

import type { SetPieceTakersView, SquadRow } from "./types";

/**
 * ── 표식들 — 명단·상세·전술판 칩이 **같은 것을 같은 모양으로** 말한다 ──────────
 *
 * 같은 숫자가 세 자리에 서므로, 그 셋이 각자 그리기 시작하면 같은 선수의 OVR이
 * 왼쪽과 오른쪽에서 달라 보인다. 여기 있는 것만 쓴다.
 */

/**
 * 그 자리의 포지션 적응도(표시용) — 규칙은 domain의 `positionProficiency` 하나뿐이다.
 * 엔진(`proficiencyAt`)도 같은 함수를 부르므로 화면 값과 서버 값이 갈리지 않는다
 * (복제하면 조용히 어긋난다). 보유 목록에 없는 자리도 도메인이 결정적으로 값을 내므로
 * "정확/추정"을 나눌 이유가 없다 — 어느 쪽이든 같은 규칙으로 나온 같은 값이다.
 */
export function fitAt(p: SquadRow, code: string): { value: number } {
  return { value: positionProficiency(p.positions, code, p.foot) };
}

/**
 * 적응도 게이지의 색 — **10 단위**로 조금씩 옮겨 간다.
 *
 * 3단계(good/ok/bad)는 79와 80이 전혀 다른 색이 되고 60과 79는 같은 색이 됐다.
 * 눈금을 잘게 두면 명단을 훑을 때 **줄이 아니라 기울기**가 먼저 읽힌다 —
 * 어디가 붉고 어디가 푸른지가 표를 읽지 않아도 보인다.
 */
export const fitClass = (v: number) => `f${Math.min(9, Math.max(0, Math.floor(v / 10)))}`;

/**
 * **이 숫자를 얼마나 믿어도 되는가** — OVR 옆의 `±N`.
 *
 * `?` 하나로는 "정확하지 않다"는 사실만 전할 뿐 **얼마나** 정확하지 않은지를
 * 말하지 못해, 갓 데려온 선수와 거의 다 적응한 선수가 같은 표식을 달게 된다.
 * `±3`과 `±1`은 감독이 그 숫자를 믿고 라인업을 짤지 말지를 가른다.
 *
 * 오차가 0이면 아무것도 그리지 않는다 — 우리 선수 대부분이 그렇고, 전원에게
 * `±0`이 붙으면 표식이 정보가 아니라 배경이 된다.
 */
export function Margin({ observation }: { observation: SquadRow["observation"] }) {
  if (observation.margin <= 0) return null;
  return (
    <span className="est" title={`이 숫자는 ±${observation.margin} 안에서만 정확합니다`}>
      ±{observation.margin}
    </span>
  );
}

/** OVR 칸의 툴팁 — 전술판 칩과 **같은 줄**을 쓴다 (같은 숫자를 다르게 설명하지 않는다) */
export function ovrTitle(p: SquadRow): string | undefined {
  return (
    [
      p.slotOverall !== null
        ? `${p.assignedPosition} 자리 기준 ${p.slotOverall} — 경기에서 쓰이는 값입니다`
        : null,
      `주 포지션(${p.position}) 기준 ${p.overall}`,
      p.observation.margin > 0
        ? `${p.observation.label} — 오차 ±${p.observation.margin}` +
          (p.settling !== null ? ` (적응 ${p.settling}%, 진행할수록 좁아집니다)` : "")
        : null,
    ]
      .filter(Boolean)
      .join("\n") || undefined
  );
}

/**
 * 완장과 서열 — **한 글자로, 같은 모양의 세 자리** (docs/data/people.md §5-1).
 *
 * 주장만 표식을 달던 자리다. 서열이 팀토크의 폭과 불만의 속도를 정하는데 화면에
 * 완장 하나만 서면, 감독은 그 판정이 어디서 나왔는지를 볼 자리가 없다.
 * 셋을 같은 글꼴·같은 크기의 원문자로 두어 **한 계열로 읽히게** 한다 — 서로 다른
 * 모양을 주면 세 표식이 각자 다른 뜻의 배지로 보인다.
 */
export function Armband({ row }: { row: SquadRow }) {
  const seat = row.isCaptain
    ? { mark: "Ⓒ", label: "주장" }
    : row.isViceCaptain
      ? { mark: "Ⓥ", label: "부주장" }
      : row.leaderRank !== null
        ? { mark: "Ⓛ", label: "라커룸 리더" }
        : null;
  if (!seat) return null;
  return (
    <i className="armband" title={`${seat.label} · 라커룸 서열 ${row.leaderRank ?? "-"}위`}>
      {seat.mark}
    </i>
  );
}

/** 표식 한 칸의 뜻 — 툴팁이 적는 사실도 이 셋뿐이다 */
const TAKER_TONE_KO = {
  on: "감독 지정",
  core: "지정 없음 — 코어가 세운다",
  idle: "지정됐지만 선발에 없어 다른 선수가 찬다",
} as const;
type TakerTone = keyof typeof TAKER_TONE_KO;

/**
 * 세트피스 표식 — **이름 앞의 한 자리, 세 칸.**
 *
 * 자리마다 표식을 하나씩 세우면 셋을 다 차는 선수의 행에서 등번호·완장 뒤로
 * 표식 셋이 줄줄이 서고, 236px짜리 이름 칸의 4분의 1이 표식 몫이 된다. 그래서
 * **표식은 하나**이고 코너·프리킥·페널티가 그 안에 늘 같은 순서로 선다 — 맡지
 * 않은 자리는 글자를 감춰 칸만 남기므로, 하나를 차든 셋을 다 차든 이름이
 * 시작하는 자리가 움직이지 않는다.
 *
 * **세 갈래는 색이 아니라 글자의 모양이 가른다** (docs/data/team.md §6):
 * 감독이 지정하고 지금 차는 자리는 진하고, 지정이 없어 코어가 세운 자리는 옅고,
 * 지정은 걸렸는데 선발에 없어 못 차는 자리는 **취소선**이다 — 이름은 남았고 공은
 * 못 찬다는 뜻이 그 모양이다. 툴팁은 같은 사실을 자리마다 한 줄씩 적을 뿐이라,
 * 열지 않아도 뜻이 선다.
 */
export function SetPieceMarks({ id, takers }: { id: string; takers: SetPieceTakersView }) {
  const slots = SET_PIECE_ROLES.map((role) => {
    const { designated, taker } = takers[role];
    const mine = designated === id;
    const kicks = taker === id;
    const tone: TakerTone | null = mine ? (kicks ? "on" : "idle") : kicks ? "core" : null;
    return { role, tone };
  });
  const held = slots.filter((s): s is { role: SetPieceRole; tone: TakerTone } => s.tone !== null);
  if (held.length === 0) return null;
  /** 자리마다 한 줄 — 사실만 적는다. 글자 셋은 소리로 읽으면 뜻이 없어 이 줄이 대신 선다 */
  const facts = held
    .map((s) => `${SET_PIECE_ROLE_KO[s.role]} 키커 — ${TAKER_TONE_KO[s.tone]}`)
    .join("\n");
  return (
    <i className="spmark" title={facts} role="img" aria-label={facts}>
      {slots.map(({ role, tone }) => (
        // 맡지 않은 자리도 글자를 그린다 — 감춰진 채로 폭을 지키는 것이 그 칸의 일이다
        <b className={`spm ${tone ?? "off"}`} key={role} aria-hidden="true">
          {SET_PIECE_ROLE_MARK[role]}
        </b>
      ))}
    </i>
  );
}

/**
 * 적응도 게이지 — **숫자가 아니라 채워진 원**.
 *
 * 적응도는 정확한 값을 읽을 일이 거의 없다. 감독이 알고 싶은 건 "이 자리를 아는
 * 선수인가"이고, 그 판단에 필요한 건 74와 76의 차이가 아니라 **얼마나 찼는가**다.
 * 숫자로 두면 명단·전술판·상세에 두 자리 수가 흩어져 OVR·나이·평점과 뒤섞이고,
 * 정작 눈으로 세로 비교가 안 된다.
 *
 * 원 하나를 `stroke-dasharray`로 잘라 그린다 — 12시에서 시계 방향. 색은 10 단위
 * 계단(`fitClass`)이고, 정확한 값은 툴팁이 갖는다.
 */
export function FitGauge({
  value,
  label = "적응도",
}: {
  value: number;
  /** 툴팁 앞머리 */
  label?: string;
}) {
  const r = 6;
  const circumference = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, value)) / 100) * circumference;
  /**
   * 보유 목록에 없는 자리도 `positionProficiency`가 결정적으로 값을 낸다 —
   * 추정도 안개도 아니라서 "(추정)"이나 물음표를 붙이지 않는다.
   */
  const title = `${label} ${value}`;
  return (
    <span className={`fit-gauge ${fitClass(value)}`} title={title} role="img" aria-label={title}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle className="fg-track" cx="8" cy="8" r={r} />
        <circle
          className="fg-fill"
          cx="8"
          cy="8"
          r={r}
          strokeDasharray={`${filled} ${circumference}`}
        />
      </svg>
    </span>
  );
}

/**
 * 폼 → **색을 섞는 양**. 그대로 |폼|을 쓰면 눈에 안 보인다.
 *
 * 폼은 대부분 0 근처에 모여 있는데(±0.3 안이 흔하다) 선형으로 섞으면 그 구간이
 * 통째로 회색에 머문다 — 0.15 차이가 화면에서 안 보였다. 제곱근에 가까운 곡선을
 * 씌워 **작은 값에서 더 크게 움직이게** 한다: 0.15 → 35%, 0.3 → 51%, 0.6 → 74%.
 * 단조증가라 순서는 그대로고, 절정·바닥(±1)에서만 색이 다 찬다.
 */
function formMix(form: number): number {
  return Math.min(1, Math.abs(form)) ** 0.55;
}

/**
 * 폼 화살표 — **도형 하나를 각도로 돌리고, 라벨은 엔진이 준 것을 그대로 쓴다.**
 *
 * 폼은 소수(−1~1)이고 라벨·색·각도의 경계는 `engine/form.ts`가 정한다
 * (±0.33 · ±0.73). UI가 따로 7단계 라벨을 갖고 있으면 같은 값이 화면과 채팅에서
 * 달라 보인다.
 *
 * 유니코드 화살표(`↑↗→↘↓`)를 쓰던 때는 일곱 단계로 끊겼고, 이중 화살표(`⇑⇓`)만
 * 폴백 폰트로 빠져 가장 강조돼야 할 절정·바닥이 되레 가늘게 보였다. 각도는
 * 엔진이 준다(`formAngle`) — 절정(+1)에서만 12시를 보고, 평소는 3시, 바닥은 6시다.
 */
export function FormArrow({
  p,
}: {
  p: Pick<SquadRow, "form" | "formLabel" | "formAngle" | "formTone">;
}) {
  const title = `${p.formLabel} (${p.form > 0 ? "+" : ""}${p.form.toFixed(2)})`;
  return (
    <span
      /**
       * 색은 **끊기지 않고 폼을 따라간다.** `formTone`은 세 단(up·flat·down)이라
       * 그걸로 칠하면 +0.19와 +0.21이 회색과 초록으로 갈린다 — 각도는 연속인데
       * 색만 계단이면 같은 값을 두 방식으로 말하게 된다.
       *
       * 뜨거운 쪽(초록/빨강)은 **부호**가 고르고, 섞는 양은 `--f`(=|폼|)가 정한다.
       * 보간은 CSS `color-mix`가 하므로 **팔레트 토큰이 그대로 원본**이다 —
       * 여기에 색값을 복사해 두면 테마를 바꿀 때 이 화살표만 옛 색으로 남는다.
       */
      className={`form-arrow ${p.formTone} ${p.form >= 0 ? "pos" : "neg"}`}
      style={{ "--f": formMix(p.form) } as CSSProperties}
      title={title}
      aria-label={`폼 ${title}`}
      data-testid="form-arrow"
      data-angle={p.formAngle}
    >
      <svg
        viewBox="0 0 24 24"
        style={{ transform: `rotate(${p.formAngle}deg)` }}
        aria-hidden="true"
      >
        <path d="M12 21 V5 M12 3.5 L5.5 11 M12 3.5 L18.5 11" />
      </svg>
    </span>
  );
}

/**
 * 최근 경기 평점 추이 — **폼이 어디서 왔는지**를 보여준다.
 *
 * 폼 숫자 하나로는 "오르는 중"과 "식는 중"을 구분할 수 없다. 왼쪽이 오래된
 * 경기고 오른쪽이 최근이라, 눈으로 훑으면 방향이 읽힌다.
 */
export function RatingTrend({ ratings }: { ratings: SquadRow["recentRatings"] }) {
  if (ratings.length === 0) return <span className="rt-empty">기록 없음</span>;
  return (
    <span className="rating-trend" data-testid="rating-trend">
      {/* 점 색의 경계는 코어가 갖는다(`ratingTone`) — 화면이 다시 자르면 기준선을
          옮길 때 색만 옛 자리에 남는다 */}
      {ratings.map((r, i) => (
        <span
          className={`rt-dot ${r.tone}`}
          key={i}
          title={`${i + 1}번째 전 경기 평점 ${r.value.toFixed(1)}`}
        >
          {r.value.toFixed(1)}
        </span>
      ))}
    </span>
  );
}

/**
 * 선수 상태 배지 묶음 — **자격 표식(HG·U21)과 같은 물건이고, 표·상세·전술판이
 * 같은 규칙을 쓴다.**
 *
 * 크기·모양이 다른 표식이 한 칸 안에 나란히 서면 같은 줄의 표식들이 서로 다른
 * 물건처럼 보인다. 크기·모양은
 * `.tag` 하나로 맞추고 **갈리는 것은 톤뿐**이다: 자격은 각주처럼 가라앉히고,
 * 감독이 지금 손을 써야 하는 상태(부상·정지·불만)는 색을 살려 눈에 남긴다.
 */
export function StatusBadges({ p }: { p: SquadRow }) {
  return (
    <>
      {p.injury && (
        <span
          className="tag st alert"
          title={`${p.injury.bodyPart} · ${p.injury.severity} · 복귀 예상 ${p.injury.expectedReturn}`}
        >
          부상
        </span>
      )}
      {p.suspended > 0 && <span className="tag st alert">정지 {p.suspended}</span>}
      {p.hasIssue && <span className="tag st alert">불만</span>}
      {p.transferListed !== null && (
        <span className="tag st note" title={`호가 ${formatMoney(p.transferListed)}`}>
          이적 리스트
        </span>
      )}
    </>
  );
}
