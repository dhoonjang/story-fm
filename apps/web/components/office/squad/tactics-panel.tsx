"use client";

import { useState } from "react";
import {
  SET_PIECE_KO,
  SET_PIECE_ROLES,
  SET_PIECE_ROLE_KO,
  TACTIC_AXES,
  tacticWord,
  type SetPieceRole,
} from "@story-fm/domain";
import { IconChevron } from "@/components/icons";
import type { SetPieceTakersView, TacticsView } from "./types";

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
                  /* 다섯 칸 중 **하나만** 서는 눈금이라 라디오 묶음이다. 선택은 색(`on`)
                     으로만 서 있었는데, 색은 색약에게도 스크린리더에게도 닿지 않는다 —
                     `aria-checked`가 같은 사실을 따로 말한다. 칸에 적힌 숫자는 눈금의
                     위치일 뿐이라 이름은 낱말(`aria-label`) 쪽이 갖는다 */
                  <div className="tactic-steps" role="radiogroup" aria-label={axis.label}>
                    {axis.words.map((label, i) => (
                      <button
                        key={label}
                        type="button"
                        role="radio"
                        aria-checked={value === i + 1}
                        aria-label={label}
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

/** 세트피스 줄에 세우는 후보 — 이름만 있으면 된다 */
export type TakerCandidate = { id: string; name: string };

/**
 * 세트피스 — **전술판 아래 한 줄.** 코너·프리킥·페널티가 나란히 선다.
 *
 * 접히지 않는다. 전술 여섯 축은 고칠 때만 쓰는 눈금이라 접어 두지만, 이 줄은
 * 「누가 차는가」라는 **읽는 값**이 절반이고 그것이 경기 득점의 4분의 1을 정한다
 * (docs/simulation/match.md §1.4). 접어 두면 감독은 지정한 적 없는 자리를 영영 보지
 * 않는다.
 *
 * **고르는 자리와 읽는 값의 생김새가 다르다.** 지정은 눌리는 물건(`select`)이고,
 * 그 옆의 이름은 테두리 없는 글자다 — 그것은 코어가 세운 사람이지 감독이 만지는
 * 값이 아니다. 두 이름이 나란히 서는 것 자체가 「지정은 남았는데 차지는 않는다」는
 * 사실이라, 그 자리에 문장을 적지 않는다.
 */
export function SetPiecePanel({
  takers,
  nameOf,
  starting,
  others,
  editing,
  onPick,
}: {
  takers: SetPieceTakersView;
  nameOf: (id: string) => string;
  /** 선발 열한 명 — 지금 실제로 찰 수 있는 사람들이라 먼저 선다 */
  starting: TakerCandidate[];
  /** 벤치·예비 — 다음 경기의 선발일 수 있어 지정은 받는다 (그 경기엔 기본값이 선다) */
  others: TakerCandidate[];
  /** 무직이면 꺼진다 — 경기 중에는 켜진 채로 지시가 된다 */
  editing: boolean;
  onPick: (role: SetPieceRole, playerId: string | null) => void;
}) {
  const listed = new Set([...starting, ...others].map((c) => c.id));
  return (
    <div className="setpiece-panel" data-testid="setpiece-panel">
      <b className="setpiece-head">{SET_PIECE_KO}</b>
      {SET_PIECE_ROLES.map((role) => {
        const { designated, taker } = takers[role];
        /** 지정과 갈릴 때만 선다 — 같으면 같은 이름을 두 번 적는 셈이다 */
        const stand = taker !== null && taker !== designated ? taker : null;
        return (
          <span className="sp-slot" key={role}>
            <i className="sp-role">{SET_PIECE_ROLE_KO[role]}</i>
            {editing ? (
              <select
                className="sp-pick"
                value={designated ?? ""}
                aria-label={`${SET_PIECE_ROLE_KO[role]} 키커`}
                data-testid={`setpiece-${role}`}
                onChange={(e) => onPick(role, e.target.value === "" ? null : e.target.value)}
              >
                <option value="">지정 없음</option>
                {/* 지정한 선수가 2군·임대로 내려가 목록 밖이면 값이 그릴 자리를 잃는다 —
                    그 한 명만 따로 세워 셀렉트가 빈칸으로 서지 않게 한다 */}
                {designated !== null && !listed.has(designated) && (
                  <option value={designated}>{nameOf(designated)}</option>
                )}
                <optgroup label="선발">
                  {starting.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
                {others.length > 0 && (
                  <optgroup label="그 외">
                    {others.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            ) : (
              <span className="sp-read">
                {designated === null ? "지정 없음" : nameOf(designated)}
              </span>
            )}
            {stand !== null && (
              <em
                className="sp-stand"
                title={
                  designated === null
                    ? "지정이 없어 이 선수가 찹니다"
                    : "지정한 선수가 선발에 없어 이 선수가 찹니다"
                }
              >
                {nameOf(stand)}
              </em>
            )}
          </span>
        );
      })}
    </div>
  );
}
