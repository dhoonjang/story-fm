import {
  formatMoney,
  isStaffRole,
  PERSONA_ROLE_LABEL,
  STAFF_ROLES,
  type Persona,
  type StaffPoolEntry,
  type StaffRole,
} from "@story-fm/domain";
import { contractUntil } from "../core/dates";
import { makeRng, randInt, shuffled } from "../core/rng";
import { teamNameIn, type GameState } from "../core/state";
import { userWageRoom } from "../club/board-request";
import { recordFinance } from "../club/finance";
import { item } from "../commands/brief";
import type { CommandResult } from "../commands/index";
import {
  inventPersonName,
  occupiedPersonNames,
  staffArchetypeOf,
  staffArchetypesOf,
  staffOf,
  staffPersona,
  staffSalaryOf,
  STAFF_LIMIT,
} from "../world/persona";
import { managerSeveranceOf } from "./manager-market";

/**
 * 스태프 시장 — **감독이 훈련장·의무실·보고서의 사람을 고르는 자리** (people.md §2-2).
 *
 * 감독 시장(`manager-market.ts`)과 같은 패턴이되 셋이 다르다:
 *
 * 1. 풀을 채우는 것이 경질이 아니라 **여름의 결정적 추첨**이다 — AI 구단엔 명명
 *    스태프가 없어 세계가 사람을 자르지 않는다.
 * 2. 부르는 쪽이 **감독뿐**이다. AI 구단은 이 시장을 돌지 않는다.
 * 3. **흥정 테이블이 없다** — 요구 연봉을 넘기면 그 자리에서 계약된다. 코치 자리
 *    하나에 3주짜리 협상을 붙이면 채팅이 사무 절차가 된다.
 *
 * 여기 있는 것은 전부 결정적 순수 로직이다 — 난수는 시드 채널을 지난다.
 */

/** 풀에 앉는 사람 수 — 역할별 자리를 다 채우고도 고를 여지가 남는 크기다 */
const STAFF_POOL_SIZE: Record<StaffRole, number> = { coach: 4, medic: 2, scout: 2 };

/** 요구 연봉의 폭 — 기준 연봉의 몇 배를 부르는가 (결정적) */
const ASK_MIN = 0.7;
const ASK_MAX = 1.4;
/** 배수를 끊는 눈금 — 정수 굴림 하나로 결정적으로 뽑기 위한 자리다 */
const ASK_STEPS = 8;

/** 계약의 길이 — 스태프는 두 시즌씩 맺는다 (people.md §2-2) */
export const STAFF_CONTRACT_SEASONS = 2;

/** 천 파운드 단위 — 연봉은 사람이 읽는 값이다 (`staffSalaryOf`와 같은 눈금) */
const SALARY_ROUNDING = 1_000;

/**
 * 그해 여름의 풀 — **(시드, 시즌) 채널로 결정적이다.**
 *
 * 요구 연봉이 **감독 구단의 눈금**을 타는 이유: 이 풀을 부르는 사람은 감독뿐이고,
 * 그가 2부 구단에 있는데 EPL 연봉을 부르는 코치만 앉아 있으면 풀이 장식이 된다.
 * 감독이 옮기면 다음 여름의 풀이 새 구단의 눈금으로 다시 선다.
 */
function drawPool(state: GameState, season: number): StaffPoolEntry[] {
  const taken = occupiedPersonNames(state);
  const rows: StaffPoolEntry[] = [];
  for (const role of STAFF_ROLES) {
    const table = shuffled(staffArchetypesOf(role), state.seed, `staff-pool:${role}:${season}`);
    const base = staffSalaryOf(state.userTeamId, role);
    for (let index = 0; index < STAFF_POOL_SIZE[role]; index += 1) {
      const rng = makeRng(state.seed, `staff-pool:${role}:${season}:${index}`);
      const archetype = table[index % table.length]!;
      const name = inventPersonName(rng, state.userTeamId, taken);
      taken.add(name);
      const step = randInt(rng, 0, ASK_STEPS);
      const factor = ASK_MIN + ((ASK_MAX - ASK_MIN) * step) / ASK_STEPS;
      rows.push({
        name,
        role,
        title: archetype.title,
        archetype: archetype.label,
        ask: Math.max(
          SALARY_ROUNDING,
          Math.round((base * factor) / SALARY_ROUNDING) * SALARY_ROUNDING,
        ),
        listedOn: season,
      });
    }
  }
  return rows;
}

/**
 * 지금 자리를 찾는 사람들 — **읽기만 한다** (people.md §2-2).
 *
 * 표가 없으면(새 게임·옛 세이브) 그해의 추첨을 그 자리에서 돌려준다. 세이브를 건드리지
 * 않는 것이 요점이다: 프롬프트 입력을 조립하는 자리(`describeStaffPool`)와 화면이 이
 * 함수를 부르는데, 입력을 만드는 일이 상태를 바꾸면 같은 턴을 두 번 그릴 때 세계가
 * 달라진다. 추첨이 결정적이라 나중에 `ensureStaffPool`이 적어 넣는 값과 같다.
 */
export function staffPoolOf(state: GameState): readonly StaffPoolEntry[] {
  return state.staffPool ?? drawPool(state, state.season);
}

/**
 * 로드 보정 — 풀이 없던 세이브를 **적어 넣는다**. 멱등이다(있으면 손대지 않는다).
 *
 * 생성이 (시드, 시즌)으로 결정적이라 채워도 그 세이브의 사람은 늘 같다 — 세이브
 * 버전을 올리지 않는 근거다 (AGENTS.md 세이브 호환성). 쓰는 자리는 여기와 고용·해고
 * 뿐이다.
 */
export function ensureStaffPool(state: GameState): void {
  if (state.staffPool !== undefined) return;
  state.staffPool = drawPool(state, state.season);
}

/**
 * 여름 갱신 — **그해 자른 사람만 남기고 다시 세운다** (people.md §2-2).
 *
 * 자른 그해 안에는 마음을 되돌릴 수 있고, 다음 여름이면 그는 다른 구단으로 갔다.
 * 그래서 남는 조건이 「이번 시즌에 올라온 줄」 하나다 — 추첨으로 선 줄은 시즌이
 * 바뀌면 어차피 새로 뽑히므로 같은 조건이 두 갈래를 함께 정리한다.
 *
 * @param season 새로 시작하는 시즌 — 전환은 `season++` 뒤에 이 함수를 부른다
 */
export function refreshStaffPool(state: GameState, season: number): void {
  const kept = (state.staffPool ?? []).filter(
    (e) => e.from !== undefined && e.listedOn >= season - 1,
  );
  const keptNames = new Set(kept.map((e) => e.name));
  state.staffPool = [...kept, ...drawPool(state, season).filter((e) => !keptNames.has(e.name))];
}

/** 풀의 한 줄을 사람으로 — 원형 표가 성격·동기·말투를 답한다 (`StaffPoolEntry` 주석) */
export function staffPersonaOf(
  state: GameState,
  entry: StaffPoolEntry,
  contract: { salary: number; until: string; since: string },
): Persona | null {
  const archetype = staffArchetypeOf(entry.role, entry.archetype);
  if (archetype === null) return null;
  return staffPersona({
    seed: state.seed,
    teamId: state.userTeamId,
    name: entry.name,
    role: entry.role,
    archetype,
    since: contract.since,
    until: contract.until,
    salary: contract.salary,
    ...(entry.from === undefined ? {} : { from: entry.from }),
  });
}

/** 그 역할에 이미 선 사람 수 — 자리 상한을 재는 자다 */
function seatedCount(state: GameState, role: StaffRole): number {
  return staffOf(state, role).length;
}

/**
 * **고용** — 풀의 이름과 감독이 부른 연봉 (people.md §2-2).
 *
 * 문 넷을 차례로 지난다: 풀에 있는 이름인가 · 요구 연봉 이상인가 · 주급 여력 안인가 ·
 * 자리가 남았는가. 넷을 다 지나면 **그 자리에서 계약된다** — 되부르기가 없다.
 *
 * 주급 여력은 선수 계약과 **같은 자**(`userWageRoom`)를 쓴다. 연봉을 주 단위로 펴서
 * 재는 이유는 그 자가 주급의 자이기 때문이고, 두 벌을 두면 스태프만 다른 세계의
 * 임금 천장을 산다.
 */
export function hireStaff(
  state: GameState,
  input: { name: string; salary: number },
): CommandResult {
  ensureStaffPool(state);
  const entry = (state.staffPool ?? []).find((e) => e.name === input.name);
  if (entry === undefined) {
    return { ok: false, message: `${input.name} — 자리를 찾는 스태프 명단에 없습니다` };
  }
  const salary = Math.max(0, Math.round(input.salary));
  if (salary < entry.ask) {
    return {
      ok: false,
      message: `${entry.name}은(는) 연봉 ${formatMoney(entry.ask)}를 부릅니다 — 제안은 ${formatMoney(salary)}였습니다`,
    };
  }
  const limit = STAFF_LIMIT[entry.role];
  if (seatedCount(state, entry.role) >= limit) {
    return {
      ok: false,
      message: `${PERSONA_ROLE_LABEL[entry.role]} 자리가 ${limit}로 다 찼습니다 — 한 사람을 내보내야 합니다`,
    };
  }
  const room = userWageRoom(state);
  const weekly = salary / WEEKS_PER_YEAR;
  if (weekly > room) {
    return {
      ok: false,
      message: `주급 여력을 넘습니다 — 연봉 ${formatMoney(salary)}는 주당 ${formatMoney(Math.round(weekly))}이고, 남은 여력은 ${formatMoney(Math.round(Math.max(0, room)))}입니다`,
    };
  }

  const persona = staffPersonaOf(state, entry, {
    salary,
    since: state.date,
    until: contractUntil(state.date, STAFF_CONTRACT_SEASONS),
  });
  if (persona === null) {
    return { ok: false, message: `${entry.name}의 원형을 찾을 수 없습니다` };
  }
  state.personas = [...(state.personas ?? []), persona];
  state.staffPool = (state.staffPool ?? []).filter((e) => e.name !== entry.name);
  const until = persona.employment!.contract.until;
  return {
    ok: true,
    message: `${entry.name} (${entry.title}) 고용 — 연봉 ${formatMoney(salary)}, ${until}까지`,
    brief: {
      head: "스태프 고용",
      items: [
        item({
          label: entry.name,
          text: entry.title,
          note: `${formatMoney(salary)}/년 · ${until}`,
        }),
      ],
    },
    tone: "good",
  };
}

/** 주급을 연봉으로 펴는 눈금 — `world/wages.ts`와 같은 자다 */
const WEEKS_PER_YEAR = 52;

/**
 * **해고** — 잔여 계약의 위약금을 구단이 문다 (people.md §2-2).
 *
 * 금액은 감독 경질과 **같은 식**(`managerSeveranceOf`)이고 연봉 1년치에서 멈춘다.
 * 자른 사람은 그해의 풀에 앉아, 같은 시즌 안에는 감독이 마음을 되돌릴 수 있다.
 *
 * ⚠️ **수석코치는 여기 오지 않는다** — 그 자리가 비면 감독 옆에 아무도 없고, 경기
 * 레퍼런스가 상주시키는 카드도 사라진다 (agents.md §5).
 */
export function releaseStaff(state: GameState, input: { name: string }): CommandResult {
  const persona = (state.personas ?? []).find((p) => isStaffRole(p.role) && p.name === input.name);
  if (persona === undefined || persona.employment === undefined) {
    return { ok: false, message: `${input.name} — 우리 구단의 스태프가 아닙니다` };
  }
  const { employment } = persona;
  const severance = managerSeveranceOf(employment.contract, state.date);
  if (severance > 0) {
    recordFinance(state, state.userTeamId, {
      kind: "expense",
      category: "severance",
      label: `${persona.name} 계약 해지 위약금`,
      amount: severance,
    });
  }
  state.personas = (state.personas ?? []).filter((p) => p.characterId !== persona.characterId);
  ensureStaffPool(state);
  state.staffPool = [
    {
      name: persona.name,
      role: persona.role as StaffRole,
      title: employment.title,
      archetype: persona.archetype,
      ask: employment.contract.salary,
      listedOn: state.season,
      from: state.userTeamId,
    },
    ...(state.staffPool ?? []).filter((e) => e.name !== persona.name),
  ];
  const paid = severance > 0 ? ` · 위약금 ${formatMoney(severance)}` : "";
  return {
    ok: true,
    message: `${persona.name} (${employment.title}) 계약 해지${paid}`,
    brief: {
      head: "스태프 계약 해지",
      items: [
        item({
          label: persona.name,
          text: "계약 해지",
          note: severance > 0 ? `위약금 ${formatMoney(severance)}` : "잔여 계약 없음",
        }),
      ],
    },
  };
}

/**
 * 만료된 스태프 계약은 **같은 조건으로 갱신된다** (people.md §2-2).
 *
 * 스태프는 흥정 테이블을 두지 않으므로 만료가 협상거리가 되지 않고, 자동으로 비우면
 * 감독이 모르는 사이 의무실에 아무도 없는 세이브가 생긴다. 사람을 바꾸려면 감독이
 * 자른다. 수석코치도 같은 문을 지난다 — 그의 계약도 구단의 것이다.
 *
 * @param season 새로 시작하는 시즌의 기준 날짜 — 시즌 전환이 넘긴다
 */
export function renewStaffContracts(state: GameState, on: string): string[] {
  const renewed: string[] = [];
  for (const persona of state.personas ?? []) {
    const employment = persona.employment;
    if (employment === undefined) continue;
    if (employment.contract.until > on) continue;
    employment.contract = {
      salary: employment.contract.salary,
      until: contractUntil(on, STAFF_CONTRACT_SEASONS),
    };
    renewed.push(persona.name);
  }
  return renewed;
}

/**
 * 자리를 찾는 사람들 한 줄씩 — 감독이 부른 이름을 그 사람으로 옮기는 자리
 * (`get_squad`·시장 해석기). **읽기만 한다** (`staffPoolOf`).
 */
export function describeStaffPool(state: GameState): string[] {
  return staffPoolOf(state).map(
    (e) =>
      `${e.name} · ${e.title} · ${e.archetype} · 요구 연봉 ${formatMoney(e.ask)}${
        e.from === undefined ? "" : ` · ${teamNameIn(state, e.from)} 출신`
      }`,
  );
}
