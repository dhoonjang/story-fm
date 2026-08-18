"use client";

import { useState } from "react";
import { IconChevron } from "@/components/icons";
import type { TacticsView } from "./types";

/**
 * 전술 5축 — 값 1~5의 뜻을 말로 보여준다. 슬라이더 숫자만 두면 "3이 뭔데?"가 된다.
 * 라벨 문구는 GM이 이해하는 축(match.md §1)과 같은 뜻이어야 한다.
 *
 * `brief`는 접힌 줄에 값과 **함께** 세우는 이름이다. "맹렬히"만 적혀 있으면 그게
 * 압박인지 템포인지 알 수 없어 툴팁을 하나씩 짚어야 했다. 축 이름을 그대로 쓰면
 * 여섯 쌍이 한 줄을 넘기므로 여기서만 짧게 줄인다.
 */
export const TACTIC_AXES = [
  {
    key: "mentality" as const,
    label: "멘탈리티",
    brief: "멘탈",
    values: ["매우 수비적", "수비적", "균형", "공격적", "매우 공격적"],
  },
  {
    key: "defensiveLine" as const,
    label: "수비 라인",
    brief: "라인",
    values: ["매우 낮게", "낮게", "보통", "높게", "매우 높게"],
  },
  {
    key: "pressing" as const,
    label: "압박",
    brief: "압박",
    values: ["최소", "약하게", "보통", "강하게", "맹렬히"],
  },
  {
    key: "tempo" as const,
    label: "템포",
    brief: "템포",
    values: ["매우 느리게", "느리게", "보통", "빠르게", "매우 빠르게"],
  },
  {
    key: "width" as const,
    label: "공격 폭",
    brief: "폭",
    values: ["매우 좁게", "좁게", "보통", "넓게", "매우 넓게"],
  },
  {
    key: "passStyle" as const,
    label: "패스",
    brief: "패스",
    values: ["매우 짧게", "짧게", "혼합", "길게", "매우 길게"],
  },
];

/**
 * 전술 패널 — **접히면 지금 값, 펼치면 눈금.**
 *
 * 판을 보는 동안 필요한 건 "지금 어떻게 서 있나"까지고, 그건 여섯 낱말로 다 적힌다.
 * 눈금 서른 칸은 고칠 때만 쓰는 것이라 늘 펼쳐 둘 이유가 없다 — 접혀 있는 동안
 * 그 높이(229px)는 전술판이 갖는다.
 *
 * 읽기 모드(경기 중 잠김)에서도 접힌다. 펼쳤을 때 눈금 대신 게이지가 나올 뿐이다.
 *
 * 낱말로만 적힌 전술은 "높게"가 얼마나 높은지, "넓게"가 어디까지인지를 감독이
 * 머릿속에서 판으로 옮겨야 한다. 그래서 값은 판 위에 선으로도 그어진다 — 선을
 * 긋는 것은 `pitch.tsx`의 그라운드고(우리 판·상대 판이 같이 쓴다) 여기는 그 값을
 * **만지는** 자리다. 그 눈금은 **화면의 감각**일 뿐 시뮬레이션 수치가 아니다 —
 * 경기 판정은 코어가 전력 패킷으로 따로 한다 (match.md §1).
 */
export function TacticsPanel({
  tactics,
  editing,
  onChange,
}: {
  tactics: TacticsView;
  editing: boolean;
  onChange: (patch: Partial<TacticsView>) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tactics-panel${open ? " open" : ""}`} data-testid="tactics-panel">
      {/* 팀 총합 적응도는 두지 않는다 — 그런 값은 없다. 적응도는 **선수마다** 다르고
          여기 있던 숫자는 선발 11인의 평균일 뿐이었다. 누가 이 전술을 아직 못 따라오는지는
          오른쪽 명단이 선수별로 말한다 */}
      <button
        className="tactics-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="tactics-toggle"
      >
        <b>전술</b>
        {/* 접혔을 때만 — 펼치면 축마다 같은 낱말이 옆에 서므로 두 번 적는 셈이 된다.
            값 앞에 축 이름을 붙인다: "맹렬히"만으로는 압박인지 템포인지 모른다 */}
        {!open && (
          <span className="tactics-brief">
            {TACTIC_AXES.map((axis) => (
              <span key={axis.key} title={axis.label}>
                <i>{axis.brief}</i>
                {axis.values[tactics[axis.key] - 1]}
              </span>
            ))}
          </span>
        )}
        <IconChevron size={13} />
      </button>
      {open && (
        <div className="tactics-grid">
          {TACTIC_AXES.map((axis) => {
            const value = tactics[axis.key];
            return (
              <div className="tactic-row" key={axis.key}>
                <span className="tactic-label">{axis.label}</span>
                {editing ? (
                  <div className="tactic-steps" role="group" aria-label={axis.label}>
                    {axis.values.map((label, i) => (
                      <button
                        key={label}
                        className={`tactic-step${value === i + 1 ? " on" : ""}`}
                        onClick={() => onChange({ [axis.key]: i + 1 } as Partial<TacticsView>)}
                        title={label}
                        data-testid={`tactic-${axis.key}-${i + 1}`}
                      >
                        {i + 1}
                      </button>
                    ))}
                    <span className="tactic-value">{axis.values[value - 1]}</span>
                  </div>
                ) : (
                  <span className="tactic-value read">
                    <span className="tactic-meter">
                      <span style={{ width: `${(value / 5) * 100}%` }} />
                    </span>
                    {axis.values[value - 1]}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
