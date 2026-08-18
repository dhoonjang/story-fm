"use client";

import { useState } from "react";
import type { MatchStage } from "@story-fm/domain";
import { Modal } from "./modal";
import {
  DOMESTIC_STAGES,
  DRAW_STYLE_KO,
  EUROPEAN_TICKET_KO,
  EURO_PRIZE_STAGES,
  HOME_RULE_KO,
  STAGE_KO,
  changedFields,
  numOf,
  type CupCatalogEntry,
  type CupCatalogResponse,
  type DomesticCupEntry,
} from "./types";

/**
 * 컵 편집 창 — 유럽 대항전과 국내 컵은 **모양이 다른 대회군**이라 창도 갈린다.
 * 대항전은 리그 페이즈(규모·티켓·통과 인원)를 갖고, 국내 컵은 순수 녹아웃이라
 * 추첨·홈 배정·라운드 일정이 열린다.
 *
 * `prize`·`windows`처럼 표 전체가 교체되는 필드는 **하위 키를 전부** 보낸다 —
 * 엔진이 얕게 얹으므로 반쪽을 보내면 나머지가 사라진다. 대신 `changedFields`가
 * 표를 한 덩어리로 비교해, 손대지 않은 표는 아예 보내지 않는다.
 */

type StageMoney = Partial<Record<MatchStage, number>>;
type StageNames = Partial<Record<MatchStage, string>>;

/** 0은 "상금 없음"과 같으므로 표에서 뺀다 — 시드에 없던 0 키를 심지 않게 */
function moneyTable(stages: readonly MatchStage[], values: Record<string, number>): StageMoney {
  const table: StageMoney = {};
  for (const stage of stages) {
    const amount = values[stage] ?? 0;
    if (amount > 0) table[stage] = amount;
  }
  return table;
}

function moneyStateOf(stages: readonly MatchStage[], table: StageMoney): Record<string, number> {
  const state: Record<string, number> = {};
  for (const stage of stages) state[stage] = table[stage] ?? 0;
  return state;
}

type MonthDay = [number, number];
type WindowTable = Record<string, MonthDay>;

/** 편집 칸이 여는 다섯 라운드 — 원래 표에 없던 단계는 빈 칸을 못 쓰므로 1월 1일에서 출발한다 */
function windowStateOf(windows: Partial<Record<MatchStage, MonthDay>>): WindowTable {
  const state: WindowTable = {};
  for (const stage of DOMESTIC_STAGES) {
    const [month, day] = windows[stage] ?? [1, 1];
    state[stage] = [month, day];
  }
  return state;
}

/**
 * 보낼 표 — **원래 표에서 출발해** 편집한 다섯 라운드만 덮어쓴다.
 *
 * `windows`는 표 전체가 교체되는 필드라, 편집이 여는 다섯 라운드만 실으면
 * `league`·`playoff`처럼 화면에 없는 키가 그대로 사라진다. 다섯 라운드는 언제나
 * 값이 있어야 저장이 받아진다 (competition.md §1).
 */
function windowTable(
  base: Partial<Record<MatchStage, MonthDay>>,
  edited: WindowTable,
): WindowTable {
  const table: WindowTable = {};
  for (const [stage, value] of Object.entries(base)) {
    if (value) table[stage] = [value[0], value[1]];
  }
  for (const stage of DOMESTIC_STAGES) table[stage] = [edited[stage][0], edited[stage][1]];
  return table;
}

/** 비운 이름은 표에서 뺀다 — 빈 문자열은 서버가 거절하고, 비움이 곧 "기본 이름"이다 */
function nameTable(names: Record<string, string>): StageNames {
  const table: StageNames = {};
  for (const stage of DOMESTIC_STAGES) {
    const label = (names[stage] ?? "").trim();
    if (label) table[stage] = label;
  }
  return table;
}

function nameStateOf(names: Partial<Record<MatchStage, string>>): Record<string, string> {
  const state: Record<string, string> = {};
  for (const stage of DOMESTIC_STAGES) state[stage] = names[stage] ?? "";
  return state;
}

function MoneyRow({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  testId: string;
}) {
  return (
    <label className="admin-field">
      {label}
      <input
        className="ai num money"
        type="number"
        min={0}
        step={100_000}
        value={value}
        onChange={(e) => onChange(numOf(e.target.value))}
        data-testid={testId}
      />
    </label>
  );
}

/* ── 유럽 대항전 ────────────────────────────── */

interface EuroFields {
  name: string;
  short: string;
  size: number;
  matchesPerTeam: number;
  slots: Record<string, number>;
  directSlots: number;
  playoffSlots: number;
  prize: {
    participation: number;
    win: number;
    draw: number;
    stage: StageMoney;
    winner: number;
  };
}

export function EuroCupModal({
  cup,
  leagues,
  onSaved,
  onClose,
}: {
  cup: CupCatalogEntry;
  leagues: Array<{ id: string; name: string; playable: boolean }>;
  onSaved: (data: CupCatalogResponse) => void;
  onClose: () => void;
}) {
  // 티켓 줄 = 지금 티켓을 받는 리그 + 리그전을 도는 리그 (없던 리그에 새로 줄 수 있게)
  const slotLeagues = [
    ...Object.keys(cup.slots),
    ...leagues.filter((l) => l.playable && cup.slots[l.id] === undefined).map((l) => l.id),
  ];

  const [name, setName] = useState(cup.name);
  const [short, setShort] = useState(cup.short);
  const [size, setSize] = useState(cup.size);
  const [matchesPerTeam, setMatchesPerTeam] = useState(cup.matchesPerTeam);
  const [directSlots, setDirectSlots] = useState(cup.directSlots);
  const [playoffSlots, setPlayoffSlots] = useState(cup.playoffSlots);
  const [slots, setSlots] = useState<Record<string, number>>(
    Object.fromEntries(slotLeagues.map((id) => [id, cup.slots[id] ?? 0])),
  );
  const [participation, setParticipation] = useState(cup.prize.participation);
  const [win, setWin] = useState(cup.prize.win);
  const [draw, setDraw] = useState(cup.prize.draw);
  const [winner, setWinner] = useState(cup.prize.winner);
  const [stagePrize, setStagePrize] = useState(moneyStateOf(EURO_PRIZE_STAGES, cup.prize.stage));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const slotSum = slotLeagues.reduce((sum, id) => sum + (slots[id] ?? 0), 0);
  const slotsMatch = slotSum === size;

  const fields: EuroFields = {
    name: name.trim(),
    short: short.trim(),
    size,
    matchesPerTeam,
    slots: Object.fromEntries(slotLeagues.filter((id) => (slots[id] ?? 0) > 0).map((id) => [id, slots[id]])),
    directSlots,
    playoffSlots,
    prize: {
      participation,
      win,
      draw,
      stage: moneyTable(EURO_PRIZE_STAGES, stagePrize),
      winner,
    },
  };

  /** 명백한 것만 막는다 — 브래킷 셈(2의 거듭제곱 등)은 엔진이 판정하고 메시지를 준다 */
  function validate(): string | null {
    if (!fields.name) return "대회 이름을 입력하세요";
    if (!fields.short) return "짧은 표기를 입력하세요";
    const numbers: Array<[string, number]> = [
      ["참가 팀 수", size],
      ["팀당 경기 수", matchesPerTeam],
      ["직행 팀 수", directSlots],
      ["플레이오프 팀 수", playoffSlots],
    ];
    for (const [label, n] of numbers) {
      if (!Number.isInteger(n) || n < 0) return `${label}는 0 이상의 정수여야 합니다`;
    }
    if (!slotsMatch) {
      return `리그별 티켓 합(${slotSum})이 참가 팀 수(${size})와 다릅니다`;
    }
    return null;
  }

  async function save() {
    const bad = validate();
    if (bad) {
      setFormError(bad);
      return;
    }
    const patch = changedFields<EuroFields>(
      {
        name: cup.name,
        short: cup.short,
        size: cup.size,
        matchesPerTeam: cup.matchesPerTeam,
        slots: cup.slots,
        directSlots: cup.directSlots,
        playoffSlots: cup.playoffSlots,
        prize: cup.prize,
      },
      fields,
    );
    if (Object.keys(patch).length === 0) {
      setFormError("바뀐 값이 없습니다");
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/catalog/cup/${cup.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data: CupCatalogResponse = await res.json();
      if (!res.ok) throw new Error(data.error ?? "요청 실패");
      onSaved(data);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      wide
      testId="cup-modal"
      title={`${name || cup.name} 편집`}
      subtitle={`유럽 대항전 · ${cup.id}`}
      onClose={onClose}
      footer={
        <>
          <button
            className="primary-btn"
            onClick={() => void save()}
            disabled={saving}
            data-testid="cup-modal-save"
          >
            {saving ? "저장 중…" : "저장"}
          </button>
          <button className="ghost-btn" onClick={onClose} disabled={saving}>
            취소
          </button>
        </>
      }
    >
      {formError && (
        <div className="admin-msg err" data-testid="cup-modal-err">
          {formError}
        </div>
      )}

      <div className="admin-fields">
        <label className="admin-field grow">
          이름
          <input value={name} onChange={(e) => setName(e.target.value)} data-testid="cup-modal-name" />
        </label>
        <label className="admin-field">
          짧은 표기
          <input value={short} onChange={(e) => setShort(e.target.value)} data-testid="cup-modal-short" />
        </label>
      </div>

      <section>
        <div className="admin-section-head">
          <b className="admin-section-title">리그 페이즈</b>
          <span className="admin-section-note">
            참가 팀 수는 짝수 · 본선 대진 수(직행 + 플레이오프/2)는 2의 거듭제곱이어야 합니다
          </span>
        </div>
        <div className="admin-fields">
          <label className="admin-field">
            참가 팀 수
            <input
              className="ai num"
              type="number"
              min={0}
              max={128}
              value={size}
              onChange={(e) => setSize(numOf(e.target.value))}
              data-testid="cup-modal-size"
            />
          </label>
          <label className="admin-field">
            팀당 경기 수
            <input
              className="ai num"
              type="number"
              min={0}
              max={64}
              value={matchesPerTeam}
              onChange={(e) => setMatchesPerTeam(numOf(e.target.value))}
              data-testid="cup-modal-matches"
            />
          </label>
          <label className="admin-field">
            본선 직행
            <input
              className="ai num"
              type="number"
              min={0}
              max={128}
              value={directSlots}
              onChange={(e) => setDirectSlots(numOf(e.target.value))}
              data-testid="cup-modal-direct"
            />
          </label>
          <label className="admin-field">
            플레이오프
            <input
              className="ai num"
              type="number"
              min={0}
              max={128}
              value={playoffSlots}
              onChange={(e) => setPlayoffSlots(numOf(e.target.value))}
              data-testid="cup-modal-playoff"
            />
          </label>
        </div>
      </section>

      <section>
        <div className="admin-section-head">
          <b className="admin-section-title">리그별 티켓</b>
          <span
            className={slotsMatch ? "admin-sum" : "admin-sum warn"}
            data-testid="cup-modal-slot-sum"
          >
            합계 {slotSum} / 참가 {size}
            {!slotsMatch && " — 참가 팀 수와 같아야 저장됩니다"}
          </span>
        </div>
        <div className="admin-kv-rows">
          {slotLeagues.map((id) => (
            <label className="admin-kv-row" key={id}>
              <span className="admin-kv-name">{leagues.find((l) => l.id === id)?.name ?? id}</span>
              <input
                className="ai num"
                type="number"
                min={0}
                max={128}
                value={slots[id] ?? 0}
                onChange={(e) => setSlots((s) => ({ ...s, [id]: numOf(e.target.value) }))}
                data-testid={`cup-modal-slot-${id}`}
              />
            </label>
          ))}
        </div>
      </section>

      <section>
        <div className="admin-section-head">
          <b className="admin-section-title">상금 (£)</b>
          <span className="admin-section-note">0이면 그 항목은 지급하지 않습니다</span>
        </div>
        <div className="admin-fields">
          <MoneyRow label="참가비" value={participation} onChange={setParticipation} testId="cup-modal-prize-participation" />
          <MoneyRow label="승리 수당" value={win} onChange={setWin} testId="cup-modal-prize-win" />
          <MoneyRow label="무승부 수당" value={draw} onChange={setDraw} testId="cup-modal-prize-draw" />
          <MoneyRow label="우승" value={winner} onChange={setWinner} testId="cup-modal-prize-winner" />
        </div>
        <div className="admin-fields admin-fields-gap">
          {EURO_PRIZE_STAGES.map((stage) => (
            <MoneyRow
              key={stage}
              label={`${STAGE_KO[stage]} 진출`}
              value={stagePrize[stage] ?? 0}
              onChange={(n) => setStagePrize((s) => ({ ...s, [stage]: n }))}
              testId={`cup-modal-prize-stage-${stage}`}
            />
          ))}
        </div>
      </section>
    </Modal>
  );
}

/* ── 국내 컵 ────────────────────────────────── */

interface DomesticFields {
  name: string;
  short: string;
  country: string;
  prestige: 1 | 2;
  twoLegged: MatchStage[];
  drawStyle: DomesticCupEntry["drawStyle"];
  firstDraw: MonthDay;
  drawDelayDays: number;
  homeRule: DomesticCupEntry["homeRule"];
  windows: WindowTable;
  stageNames: StageNames;
  finalMidweek: boolean | undefined;
  europeanTicket: DomesticCupEntry["europeanTicket"];
  prize: { round: StageMoney; winner: number; runnerUp: number };
}

const DRAW_STYLES = Object.keys(DRAW_STYLE_KO) as Array<DomesticCupEntry["drawStyle"]>;
const HOME_RULES = Object.keys(HOME_RULE_KO) as Array<DomesticCupEntry["homeRule"]>;
const TICKETS = Object.keys(EUROPEAN_TICKET_KO) as Array<DomesticCupEntry["europeanTicket"]>;

export function DomesticCupModal({
  cup,
  onSaved,
  onClose,
}: {
  cup: DomesticCupEntry;
  onSaved: (data: CupCatalogResponse) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(cup.name);
  const [short, setShort] = useState(cup.short);
  const [country, setCountry] = useState(cup.country);
  const [prestige, setPrestige] = useState<1 | 2>(cup.prestige);
  const [twoLegged, setTwoLegged] = useState<string[]>([...cup.twoLegged]);
  const [drawStyle, setDrawStyle] = useState(cup.drawStyle);
  const [firstDraw, setFirstDraw] = useState<MonthDay>([cup.firstDraw[0], cup.firstDraw[1]]);
  const [drawDelayDays, setDrawDelayDays] = useState(cup.drawDelayDays);
  const [homeRule, setHomeRule] = useState(cup.homeRule);
  const [windows, setWindows] = useState<WindowTable>(windowStateOf(cup.windows));
  const [stageNames, setStageNames] = useState<Record<string, string>>(
    nameStateOf(cup.stageNames ?? {}),
  );
  const [finalMidweek, setFinalMidweek] = useState(cup.finalMidweek ?? false);
  const [europeanTicket, setEuropeanTicket] = useState(cup.europeanTicket);
  const [roundPrize, setRoundPrize] = useState(moneyStateOf(DOMESTIC_STAGES, cup.prize.round));
  const [winner, setWinner] = useState(cup.prize.winner);
  const [runnerUp, setRunnerUp] = useState(cup.prize.runnerUp);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const fields: DomesticFields = {
    name: name.trim(),
    short: short.trim(),
    country: country.trim(),
    prestige,
    twoLegged: DOMESTIC_STAGES.filter((s) => twoLegged.includes(s)),
    drawStyle,
    firstDraw,
    drawDelayDays,
    homeRule,
    windows: windowTable(cup.windows, windows),
    stageNames: nameTable(stageNames),
    // 시드에 없던 필드를 false로 심으면 손대지 않아도 "편집됨"이 된다
    finalMidweek: finalMidweek === (cup.finalMidweek ?? false) ? cup.finalMidweek : finalMidweek,
    europeanTicket,
    prize: { round: moneyTable(DOMESTIC_STAGES, roundPrize), winner, runnerUp },
  };

  function validate(): string | null {
    if (!fields.name) return "대회 이름을 입력하세요";
    if (!fields.short) return "짧은 표기를 입력하세요";
    if (!fields.country) return "나라를 입력하세요";
    if (!Number.isInteger(drawDelayDays) || drawDelayDays < 0) {
      return "추첨 지연 일수는 0 이상의 정수여야 합니다";
    }
    const dates: Array<[string, [number, number]]> = [
      ["1라운드 추첨일", firstDraw],
      ...DOMESTIC_STAGES.map((s): [string, [number, number]] => [
        `${STAGE_KO[s]} 목표일`,
        windows[s],
      ]),
    ];
    for (const [label, [month, day]] of dates) {
      if (!Number.isInteger(month) || month < 1 || month > 12) return `${label}의 월은 1~12여야 합니다`;
      if (!Number.isInteger(day) || day < 1 || day > 31) return `${label}의 일은 1~31이어야 합니다`;
    }
    return null;
  }

  async function save() {
    const bad = validate();
    if (bad) {
      setFormError(bad);
      return;
    }
    const patch = changedFields<DomesticFields>(
      {
        name: cup.name,
        short: cup.short,
        country: cup.country,
        prestige: cup.prestige,
        twoLegged: [...cup.twoLegged],
        drawStyle: cup.drawStyle,
        firstDraw: cup.firstDraw,
        drawDelayDays: cup.drawDelayDays,
        homeRule: cup.homeRule,
        windows: windowTable(cup.windows, windowStateOf(cup.windows)),
        stageNames: nameTable(nameStateOf(cup.stageNames ?? {})),
        finalMidweek: cup.finalMidweek,
        europeanTicket: cup.europeanTicket,
        prize: cup.prize,
      },
      fields,
    );
    if (Object.keys(patch).length === 0) {
      setFormError("바뀐 값이 없습니다");
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/catalog/cup/${cup.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data: CupCatalogResponse = await res.json();
      if (!res.ok) throw new Error(data.error ?? "요청 실패");
      onSaved(data);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function setWindow(stage: string, index: 0 | 1, value: number) {
    setWindows((w) => {
      const next: MonthDay = [w[stage][0], w[stage][1]];
      next[index] = value;
      return { ...w, [stage]: next };
    });
  }

  return (
    <Modal
      wide
      testId="cup-modal"
      title={`${name || cup.name} 편집`}
      subtitle={`국내 컵 · ${cup.id}`}
      onClose={onClose}
      footer={
        <>
          <button
            className="primary-btn"
            onClick={() => void save()}
            disabled={saving}
            data-testid="cup-modal-save"
          >
            {saving ? "저장 중…" : "저장"}
          </button>
          <button className="ghost-btn" onClick={onClose} disabled={saving}>
            취소
          </button>
        </>
      }
    >
      {formError && (
        <div className="admin-msg err" data-testid="cup-modal-err">
          {formError}
        </div>
      )}

      <div className="admin-fields">
        <label className="admin-field grow">
          이름
          <input value={name} onChange={(e) => setName(e.target.value)} data-testid="cup-modal-name" />
        </label>
        <label className="admin-field">
          짧은 표기
          <input value={short} onChange={(e) => setShort(e.target.value)} data-testid="cup-modal-short" />
        </label>
        <label className="admin-field">
          나라
          <input
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            data-testid="cup-modal-country"
          />
        </label>
        <label className="admin-field">
          명성 (1이 위)
          <select
            value={prestige}
            onChange={(e) => setPrestige(numOf(e.target.value) === 1 ? 1 : 2)}
            data-testid="cup-modal-prestige"
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </label>
        <label className="admin-field">
          유럽 진출권
          <select
            value={europeanTicket}
            onChange={(e) => setEuropeanTicket(e.target.value as DomesticCupEntry["europeanTicket"])}
            data-testid="cup-modal-ticket"
          >
            {TICKETS.map((t) => (
              <option key={t} value={t}>
                {EUROPEAN_TICKET_KO[t]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section>
        <div className="admin-section-head">
          <b className="admin-section-title">방식</b>
          <span className="admin-section-note">2차전제로 치르는 단계 · 추첨과 홈 배정 규정</span>
        </div>
        <div className="admin-checks">
          {DOMESTIC_STAGES.map((stage) => (
            <label className="admin-check" key={stage}>
              <input
                type="checkbox"
                checked={twoLegged.includes(stage)}
                onChange={(e) =>
                  setTwoLegged((cur) =>
                    e.target.checked ? [...cur, stage] : cur.filter((s) => s !== stage),
                  )
                }
                data-testid={`cup-modal-twolegged-${stage}`}
              />
              {STAGE_KO[stage]}
            </label>
          ))}
        </div>
        <div className="admin-fields admin-fields-gap">
          <label className="admin-field">
            추첨 방식
            <select
              value={drawStyle}
              onChange={(e) => setDrawStyle(e.target.value as DomesticCupEntry["drawStyle"])}
              data-testid="cup-modal-drawstyle"
            >
              {DRAW_STYLES.map((s) => (
                <option key={s} value={s}>
                  {DRAW_STYLE_KO[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field">
            홈 배정
            <select
              value={homeRule}
              onChange={(e) => setHomeRule(e.target.value as DomesticCupEntry["homeRule"])}
              data-testid="cup-modal-homerule"
            >
              {HOME_RULES.map((r) => (
                <option key={r} value={r}>
                  {HOME_RULE_KO[r]}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field">
            1라운드 추첨 (월·일)
            <span className="admin-date">
              <input
                className="ai num"
                type="number"
                min={1}
                max={12}
                value={firstDraw[0]}
                onChange={(e) => setFirstDraw(([, day]): MonthDay => [numOf(e.target.value), day])}
                aria-label="추첨 월"
                data-testid="cup-modal-firstdraw-month"
              />
              <input
                className="ai num"
                type="number"
                min={1}
                max={31}
                value={firstDraw[1]}
                onChange={(e) => setFirstDraw(([month]): MonthDay => [month, numOf(e.target.value)])}
                aria-label="추첨 일"
                data-testid="cup-modal-firstdraw-day"
              />
            </span>
          </label>
          <label className="admin-field">
            다음 추첨 지연 (일)
            <input
              className="ai num"
              type="number"
              min={0}
              max={60}
              value={drawDelayDays}
              onChange={(e) => setDrawDelayDays(numOf(e.target.value))}
              data-testid="cup-modal-drawdelay"
            />
          </label>
          <label className="admin-field admin-check">
            <input
              type="checkbox"
              checked={finalMidweek}
              onChange={(e) => setFinalMidweek(e.target.checked)}
              data-testid="cup-modal-midweek"
            />
            결승을 주중 밤에
          </label>
        </div>
      </section>

      <section>
        <div className="admin-section-head">
          <b className="admin-section-title">라운드</b>
          <span className="admin-section-note">
            목표 날짜(월·일)와 라운드 이름 — 이름을 비우면 규모 기본값(32강·16강…)을 씁니다
          </span>
        </div>
        <div className="admin-kv-rows">
          {DOMESTIC_STAGES.map((stage) => (
            <div className="admin-kv-row" key={stage}>
              <span className="admin-kv-name">{STAGE_KO[stage]}</span>
              <input
                className="ai num"
                type="number"
                min={1}
                max={12}
                value={windows[stage][0]}
                onChange={(e) => setWindow(stage, 0, numOf(e.target.value))}
                aria-label={`${STAGE_KO[stage]} 월`}
                data-testid={`cup-modal-window-${stage}-month`}
              />
              <input
                className="ai num"
                type="number"
                min={1}
                max={31}
                value={windows[stage][1]}
                onChange={(e) => setWindow(stage, 1, numOf(e.target.value))}
                aria-label={`${STAGE_KO[stage]} 일`}
                data-testid={`cup-modal-window-${stage}-day`}
              />
              <input
                className="admin-kv-text"
                value={stageNames[stage] ?? ""}
                onChange={(e) => setStageNames((s) => ({ ...s, [stage]: e.target.value }))}
                placeholder={STAGE_KO[stage]}
                aria-label={`${STAGE_KO[stage]} 라운드 이름`}
                data-testid={`cup-modal-stagename-${stage}`}
              />
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="admin-section-head">
          <b className="admin-section-title">상금 (£)</b>
          <span className="admin-section-note">0이면 그 항목은 지급하지 않습니다</span>
        </div>
        <div className="admin-fields">
          <MoneyRow label="우승" value={winner} onChange={setWinner} testId="cup-modal-prize-winner" />
          <MoneyRow label="준우승" value={runnerUp} onChange={setRunnerUp} testId="cup-modal-prize-runnerup" />
        </div>
        <div className="admin-fields admin-fields-gap">
          {DOMESTIC_STAGES.map((stage) => (
            <MoneyRow
              key={stage}
              label={`${STAGE_KO[stage]} 진출`}
              value={roundPrize[stage] ?? 0}
              onChange={(n) => setRoundPrize((s) => ({ ...s, [stage]: n }))}
              testId={`cup-modal-prize-round-${stage}`}
            />
          ))}
        </div>
      </section>
    </Modal>
  );
}
