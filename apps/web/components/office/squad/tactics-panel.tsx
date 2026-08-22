"use client";

import { useState } from "react";
import { TACTIC_AXES, tacticWord } from "@story-fm/domain";
import { IconChevron } from "@/components/icons";
import type { TacticsView } from "./types";

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
                {tacticWord(axis.key, tactics[axis.key])}
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
                    {axis.words.map((label, i) => (
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
                    <span className="tactic-value">{tacticWord(axis.key, value)}</span>
                  </div>
                ) : (
                  <span className="tactic-value read">
                    <span className="tactic-meter">
                      <span style={{ width: `${(value / 5) * 100}%` }} />
                    </span>
                    {tacticWord(axis.key, value)}
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
