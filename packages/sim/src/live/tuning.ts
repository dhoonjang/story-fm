import type { LiveAction, PlayPhase, WeightSlot } from "@story-fm/domain";
import type { TendencyAxis } from "./roles";
import { LIVE_STEP } from "@story-fm/domain";
import type { ShotContext } from "./xg";

/**
 * 실시간 경기의 **눈금 전부** — 말의 규칙이 읽는 상수가 이 한 파일에 모여 있다
 * (live-match.md §9.3 · 근거는 football-reference.md).
 *
 * 규칙(판단·이동·경합의 식)은 각 파일에 있고, 그 식에 들어가는 숫자는 여기서 가져간다. 밸런스를
 * 옮기는 일은 이 파일 안에서 끝나야 한다 — 식을 고치는 일과 눈금을 옮기는 일을 가른다.
 * 각 값이 실측의 어디에 매였는지는 하네스(`live-match-stats` · `live-player-load` ·
 * `live-tactics` · `sim-parity`)가 잰다. 역할 성향표(`roles.ts`)는 역할의 정의라 여기 없다.
 *
 * 절은 그 값을 읽는 파일 순서다. 두 시뮬이 함께 읽는 경기 상수는 여기 없고 제자리에 있다 —
 * 카드·부상 총량(`discipline-model.ts` · `injury-model.ts`), 부하와 체력(`load.ts`), 벤치
 * 정책(`bench.ts`), 실측 비율(`football-rates.ts`), 시트 한도(`sheet.ts`), 간이 시뮬
 * (`engine/src/match/quick-sim.ts`). 상수와 근거의 표는 match.md §10이다.
 */

// ── 시계 · 추가시간 · 벤치 (러너) (`runner.ts`) ─────────────────────────────────────

/** 하프마다의 기본 추가시간 (초) — 실측 경기 길이 97~100분 (football-reference.md §4) */
export const ADDED_TIME_BASE: Record<PlayPhase, number> = {
  first_half: 20,
  second_half: 80,
  extra_first: 20,
  extra_second: 45,
};

/** 화면 없는 AI 경기가 한 번에 미는 틱 — 경기 시간 5분 */
export const HEADLESS_CHUNK_TICKS = Math.round((5 * 60) / LIVE_STEP);

export const BENCH_INTERVAL_SECONDS = 60;

// ── 한 틱 — 판단 · 패스 · 슈팅 · 경합 · 파울 · 골키퍼 · 재시작 (`step.ts`) ──────────────────

/** 공 없는 판단의 간격 (초) — 반응 시간 */
export const DECIDE_INTERVAL = 0.45;

/** 느슨한 공을 쫓는 반경 (m) — 편마다 가장 가까운 말이 간다 */
export const CHASE_RADIUS = 40;

/** 두 번째 말도 함께 쫓는 반경 (m) */
export const CHASE_SECOND_RADIUS = 8;

/** 패스가 떨어진 자리에서 받는 말이 공을 거두는 반경 (m) — 첫 터치의 팔 길이 */
export const RECEIVE_RADIUS = 2.6;

/** 공 가진 말의 기본 판단 간격 (초) — 템포가 곱한다 */
export const CARRIER_DECIDE_INTERVAL = 1.8;

/** 압박을 받는 공 가진 말의 판단 간격 (초) */
export const CARRIER_PRESSED_INTERVAL = 0.9;

/** 길목의 상대 앞에서 짧게 몰고 가는 걸음의 판단 간격 (초) */
export const SLOW_CARRY_SECONDS = 0.6;

/** 압박으로 치는 거리 (m) */
export const PRESSURE_RADIUS = 3.5;

/** 압박에 나서는 거리 (m) — 이 안의 말만 공을 향한다 */
export const PRESS_RADIUS = 22;

/** 압박하는 말이 공 가진 상대의 골 쪽에서 서는 거리 (m) — 덤비지 않고 길을 막는다 */
export const PRESS_STANDOFF = 1.8;

/** 태클을 시도하는 거리 (m) */
export const TACKLE_RANGE = 1.4;

/** 앞길을 막아선 상대와 1대1이 되는 거리 (m) — 이 안이면 드리블은 곧 승부다 */
export const DUEL_RANGE = 2.5;

/** 제쳐진 수비가 다시 움직이기까지의 시간 (초) */
export const BEATEN_SECONDS = 1.2;

/** 틱마다 태클을 시도할 확률 — 붙어 있는 1초에 한 번쯤 */
export const TACKLE_ATTEMPT = 0.002;

/** 달려오는 공 가진 말의 앞길에 선 수비의 틱당 태클 시도 — 길을 막는 몸이다 */
export const TACKLE_IN_PATH = 0.007;

/**
 * 1대1의 수비 쪽 여유 (능력치 점) — 능력이 같으면 태클이 약 80% 이긴다. 드리블은 제칠 수 있는 상대에게만
 * 거는 선택이라 실제 드리블 성공이 실측 45%쯤에, 태클 성공이 실측 61%(StatsBomb 12.0/19.7) 아래
 * 밴드에 선다 (football-reference.md §5). 여유가 클수록 확률이 끝에 붙어 능력 차가 결과를 덜 움직인다
 */
export const DUEL_TACKLER_EDGE = 30;

/** 1대1 능력치 차의 눈금 — 10점 차가 로짓 0.45(약 11%p) */
export const DUEL_SCALE = 22;

/** 몸싸움 파울 — 이 거리 안에 붙은 수비의 틱당 확률 */
export const HOLDING_RANGE = 1.0;

export const HOLDING_FOUL = 0.0012;

/** 자기 박스 안의 수비 — 덤비지 않고 막아선다. 태클 시도에 곱한다 */
export const BOX_RESTRAINT = 0.2;

/**
 * 자기 박스 안의 파울 — 페널티가 걸린 접촉이라 수비가 몸을 사린다. 태클·몸싸움·공중볼의
 * 파울 확률에 곱한다. 실측 페널티는 팀-경기당 0.154개, 파울 11개의 1.4%다
 * (football-reference.md §2)
 */
export const BOX_FOUL_RESTRAINT = 0.025;

/** 넣기로 정해진 페널티 앞에서 골키퍼가 반대로 몸을 던져 다시 서기까지 (초) */
export const PENALTY_WRONG_WAY_SECONDS = 1.5;

/** 슛의 경로를 몸으로 막는 거리 (m) — 팔 길이보다 몸이 넓다 */
export const BLOCK_REACH = 1.2;

/**
 * 경로에 닿는 필드 상대가 슛을 실제로 막는 확률 — 위치선정 `BLOCK_SKILL_PIVOT`에서.
 * 실측 1.4m 길목에 상대 하나가 선 슛의 33%, 둘 45%, 셋 51%가 막힌다 (StatsBomb 일반 플레이)
 */
export const BLOCK_CHANCE = 0.55;

/** 몸 막기의 위치선정 기준점과 1점당 확률 배율 — 슛 길을 읽는 수비가 몸을 먼저 넣는다 */
export const BLOCK_SKILL_PIVOT = 65;

export const BLOCK_SKILL_SLOPE = 0.012;

/** 태클 강도 갈래가 시도율과 파울에 곱하는 배수 */
export const TACKLING_FACTOR = { soft: 0.7, normal: 1, hard: 1.35 } as const;

/** 실패한 태클이 파울이 되는 기본 확률 */
export const FOUL_ON_FAILED_TACKLE = 0.7;

/** 성공한 태클이 파울로 불리는 확률 — 주심의 눈 */
export const FOUL_ON_WON_TACKLE = 0.3;

/** 공중볼 경합에서 파울이 나는 확률 */
export const FOUL_ON_AERIAL = 0.16;

/** 역습을 끊은 파울이 경고가 되는 확률 */
export const CARD_ON_CYNICAL = 0.62;

/** 명백한 득점 기회 저지가 곧장 퇴장이 되는 확률 */
export const RED_ON_DOGSO = 0.55;

/** 위험한 태클(적극성 높고 늦은)이 곧장 퇴장이 되는 확률 */
export const RED_ON_RECKLESS = 0.02;

/** 패스 방향 오차 — 거리 1m마다의 가로 표준편차 (능력 100·압박 없음 기준의 배수 1) */
export const PASS_ANGLE_ERROR = 0.07;

/** 패스 세기 오차 — 거리 1m마다의 세로 표준편차 */
export const PASS_LENGTH_ERROR = 0.1;

/**
 * 패스 선택의 길목 판정 — 상대의 인터셉트 반경에 이 여유 (m)를 더하고, 패서의 부정확도에
 * `PASS_THREAD_BASE`를 더한 배율을 곱한다. 리그 평균의 패서에서 배율이 1 남짓이고 좋은 패서일수록 작다 —
 * 좋은 패서는 막힐 줄 알던 길목을 열린 길로 본다
 */
export const PASS_LANE_MARGIN = 0.35;

export const PASS_THREAD_BASE = 0.4;

/**
 * 패스의 부정확도 = `PASS_SLOPPINESS_AT_PIVOT` × 2^(−(패스 − `PASS_SKILL_PIVOT`) ÷ `PASS_SKILL_HALVING`).
 * 리그 평균의 패서(58)에서 0.67이고 15점마다 절반·두 배다 — 실측 팀 패스 성공률의 팀 간 sd 4.9%p
 * (72.3~90.5%, football-reference.md [FM])가 패서의 능력 차에서 나온다
 */
export const PASS_SLOPPINESS_AT_PIVOT = 0.67;

export const PASS_SKILL_PIVOT = 58;

export const PASS_SKILL_HALVING = 15;

/** 3.5m 안의 상대 하나가 오차에 더하는 몫 */
export const PASS_PRESSURE_ERROR = 0.45;

/** 뜬 패스의 오차 배수 */
export const PASS_LOFT_ERROR = 1.7;

/** 패스 속도 (m/s) — 짧게 12, 길게 22 */
export const PASS_SPEED_MIN = 12;

/** 패스 오차 — 길이 1m당 목표에서 벗어나는 m, 패스 능력 0에서 */
export const PASS_SPEED_MAX = 22;

/** 슈팅 속도 (m/s) — 킥력이 정한다 */
export const SHOT_SPEED_MIN = 19;

export const SHOT_SPEED_SPAN = 12;

/** 슈팅 오차(m, 골라인에서) — 결정력 0에서 */
export const SHOT_ERROR_BASE = 5.4;

/** 결정력 99가 줄이는 몫 */
export const SHOT_ERROR_SKILL = 0.6;

/** 선방 — 골키핑 60이 정면의 중간 슛을 막는 확률의 로짓 */
export const SAVE_LOGIT_BASE = 2;

/** 골키퍼가 슛에 반응하는 시간 (초) */
export const KEEPER_REACTION_SECONDS = 0.15;

/** 골라인에 닿는 슛에 골키퍼가 몸을 던져 닿는 가로 거리 (m) — 골키핑이 조금 늘린다 */
export const DIVE_REACH = 3.6;

/** 골키퍼가 골라인에서 이보다 멀리 나와 있으면 골라인의 슛에 닿지 못한다 (m) */
export const DIVE_DEPTH = 10;

export const SAVE_KEEPER_SCALE = 15;

/** 골문 중심에서 벗어난 1m당 선방 로짓의 감소 */
export const SAVE_PLACEMENT = 0.55;

/** 슈팅 거리 1m당 선방 로짓의 증가 */
export const SAVE_DISTANCE = 0.075;

/** 첫 터치가 흘러 나가는 기본 확률 — 드리블 0·압박 없음에서 */
export const TOUCH_ERROR_BASE = 0.22;

/** 공을 받아 다음 판단까지의 시간 (초) — 컨트롤과 고개 들기 */
export const FIRST_TOUCH_SECONDS = 1.6;

/** 공중볼 경합 파울·부상·헤더가 도는 반경 (m) */
export const AERIAL_RADIUS = 2.2;

/** 따낸 공중볼을 헤더로 골문에 보내는 거리 (m)와 그 확률 — 나머지는 떨어뜨려 잡는다 */
export const HEADER_RANGE = 12;

export const HEADER_SHOT_CHANCE = 0.6;

/** 전환 국면의 길이 (초) */
export const TRANSITION_SECONDS = 5;

/** 슈팅을 고르는 효용의 배율 — 패스의 위협 이득과 같은 저울에 올린다 */
export const SHOT_VALUE = 1.0;

/** 패스·운반의 위협 이득에 곱하는 배율 */
export const THREAT_VALUE = 3;

/** 잃었을 때의 위험에 곱하는 배율 */
export const RISK_VALUE = 3.2;

/** 아무 것도 아닌 선택(지키기)의 효용 — 이 아래면 걷어낸다 */
export const HOLD_UTILITY = -0.04;

/**
 * 공을 지키는 말에게 붙은 상대 하나가 다음 판단 전에 달려드는 몫. 실측 압박(StatsBomb
 * pressure)의 약 30%가 5초 안에 공을 되찾는다 (football-reference.md §4)
 */
export const HOLD_CHALLENGE = 0.15;

/** 드리블을 고르는 문턱 — 이만큼의 효용이 남아야 상대를 제치러 간다 */
export const DRIBBLE_BIAS = 0.06;

/** 공을 지키는 패스의 값 — 성공 확률에 곱한다. 전진하지 않는 패스도 이 값으로 고른다 */
export const KEEP_VALUE = 0.05;

/** 공을 잃으면 지금 자리의 위협도 잃는다 — 그 몫 */
export const LOSS_SHARE = 0.5;

/** 공 가진 상대를 막으러 나서는 첫 수비수의 반경 (m) — 압박선과 무관하게 한 명은 붙는다 */
export const ENGAGE_RADIUS = 18;

/** 재시작을 기다리는 키커가 서는 자리 — 공 뒤(제 골 쪽)로 떨어진 거리 (m) */
export const SET_PIECE_STANCE = 1;

/** 키커가 선 자리에서 공으로 도움닫기하는 시간 (초) — 킥 시각 앞 */
export const SET_PIECE_RUNUP_SECONDS = 1;

/** 재시작마다 공이 멈춰 있는 시간 (초) */
export const RESTART_DEAD_SECONDS = {
  kickoff: 3,
  goal_kick: 34,
  throw_in: 22,
  corner: 42,
  free_kick: 38,
  penalty: 40,
} as const;

/** 걷어낸 공이 흩어지는 가로 폭 (m) */
export const CLEARANCE_SPREAD = 70;

/** 줄 밖으로 나간 공이 멈추는 한계 (m) — 비행의 목적지가 경기장에서 이만큼까지 나갈 수 있다 */
export const OUT_MARGIN = 4;

/** 골키퍼가 없을 때의 오프셋 (m) — xG의 골키퍼 항이 상한에 선다 */
export const KEEPER_ABSENT_OFFSET = 6;

/** 위험 지역 — 우리 골라인에서 이 거리 안의 공에는 둘째 수비가 좁혀 든다 (m)와 그 수비를 찾는 반경 */
export const DANGER_DEPTH = 30;

export const DANGER_CLOSE_RADIUS = 15;

/**
 * 자리의 느린 흔들림 — 자리별 진폭 (m)과 주기 (초). 실측 선수는 경기 시간의 절반 가까이
 * 걷는다. 수비 라인과 미드필드는 라인을 맞추느라 쉬지 않고 자리를 고치고, 최전방은 상대
 * 라인 앞에 서서 기다린다.
 */
export const SHAPE_DRIFT: Record<WeightSlot, number> = {
  GK: 2,
  CB: 3,
  FB: 2,
  DM: 3.3,
  CM: 3.3,
  AM: 2.4,
  W: 1,
  CF: 0.6,
  ST: 0.6,
};

export const SHAPE_DRIFT_PERIOD = 13.5;

/** 터치라인에서 이 거리 안의 경합은 공이 라인 쪽으로 튀기 쉽다 (m)와 그 몫 */
export const TOUCHLINE_DUEL_BAND = 8;

export const TOUCHLINE_KNOCK_OUT = 0.55;

/** 크로스가 떠난 뒤 이 거리 안에서 걸리면 막힌 크로스다 (m)와 그것이 코너가 되는 몫 */
export const CROSS_BLOCK_WINDOW = 6;

export const CROSS_BLOCK_CORNER = 0.65;

/** 몸에 맞은 슛이 골라인 밖으로 나가 코너가 되는 몫 */
export const BLOCKED_SHOT_CORNER = 0.45;

/** 크로스를 고르는 문턱 — 박스에 사람이 있어도 공을 지킬 수 있으면 참는다 */
export const CROSS_RESERVE = 0.06;

/** 헤더로 걷어낸 공이 날아가는 거리 (m) — 최소와 폭 */
export const HEAD_CLEAR_MIN = 10;

/** 헤더로 걷어내는 자리 — 우리 골라인에서 이 깊이 안 (m). 미드필드의 공중볼은 따낸 쪽이 잡는다 */
export const HEAD_CLEAR_DEPTH = 35;

export const HEAD_CLEAR_SPAN = 20;

/** 슈팅 길목으로 치는 폭 (m) — 몸이 슛을 막는 거리 */
export const BLOCK_LANE = 1.4;

/** 패스가 떨어질 자리에서 이만큼 떨어진 곳에서 끊어야 인터셉트다 (m) — 떨어진 공을 줍는 것은 회복이다 */
export const INTERCEPT_MIN_GAP = 16;

/**
 * 인터셉트의 반경 (m) — 수비의 읽기(위치선정 0.6 + 태클 0.4)가 `INTERCEPT_REACH_PIVOT`일 때
 * `INTERCEPT_REACH_BASE`이고 한 점마다 `INTERCEPT_REACH_PER_POINT`씩 달라진다. 팀 간 수비 수준의
 * 차이가 공을 끊는 빈도로 선다 — 평균이 아니라 그 퍼짐이 이 눈금의 몫이다
 */
export const INTERCEPT_REACH_BASE = 0.85;

export const INTERCEPT_REACH_PIVOT = 55;

export const INTERCEPT_REACH_PER_POINT = 0.012;

export const INTERCEPT_REACH_MIN = 0.45;

/** 튕긴 공이 구르는 속도 (m/s) */
export const ROLL_SPEED = 7;

/** 잔디 위 구르는 공의 감속 (m/s²) — 남은 속도가 구를 거리를 정한다 */
export const ROLL_DECELERATION = 2.2;

/** 빗나간 패스가 이어서 구르는 거리의 상한 (m) */
export const ROLL_ON_MAX = 25;

/** 태클에 맞은 공이 구르는 거리 (m) — 최소와 폭 */
export const TACKLE_ROLL_MIN = 2;

export const TACKLE_ROLL_SPAN = 9;

/** 골 뒤 킥오프까지의 멈춤 (초) — 세리머니와 복귀 */
export const GOAL_DEAD_SECONDS = 55;

/** 중단이 추가시간에 얹는 초 */
export const STOPPAGE_SECONDS = { goal: 30, injury: 75, card: 15, penalty: 20 } as const;

/** 직접 프리킥을 노리는 거리 (m) */
export const DIRECT_FREE_KICK_RANGE = 27;

/** 직접 프리킥을 고르는 확률 — 사거리 안에서 */
export const DIRECT_FREE_KICK_CHANCE = 0.4;

/** 세트피스 뒤 몇 초 안의 슛을 세트피스 슛으로 세는가 */
export const SET_PIECE_WINDOW_SECONDS = 9;

// 뛰는 몸 — 자리마다 달리는 곳이 다르다 (football-reference.md §7)

/**
 * 상대 진영의 공에 붙는 첫 수비수의 급함 — 길을 막으며 따라붙는 걸음(약 20 km/h)이다.
 * 전력 질주는 압박선 안과 역압박의 몫이다.
 */
export const PRESS_JOCKEY_URGENCY = 0.66;

/** 전력 질주 — 최고 속도 그대로 */
export const URGENCY_FULL = 1;

/** 상대 진영의 공에 첫 수비수가 나서는 반경 (m) — 압박선 밖에서는 가까운 말만 붙는다 */
export const JOCKEY_ENGAGE_RADIUS = 12;

/** 마크한 상대가 이만큼 달아나면 (m) 따라 뛴다 — 침투를 쫓는 수비 */
export const MARK_TRACK_GAP = 4;

export const MARK_TRACK_URGENCY = 0.72;

/**
 * 공을 잃었을 때 자리로 되돌아 뛰는 급함 — 고속 주행 구간(19.8~25.2 km/h)의 걸음이다.
 * 수비 라인과 미드필드가 이 몫을 가장 많이 뛰고, 최전방은 걸어서 돌아온다.
 */
export const RECOVERY_URGENCY: Record<WeightSlot, number> = {
  GK: 0,
  CB: 0.78,
  FB: 0.68,
  DM: 0.72,
  CM: 0.72,
  AM: 0.68,
  W: 0.6,
  CF: 0,
  ST: 0,
};

/** 자리가 이만큼 멀어야 (m) 되돌아 뛴다 — 가까운 어긋남은 걸어서 메운다 */
export const RECOVERY_GAP = 7;

/** 자리가 이만큼 멀면 (m) 전력으로 되돌아간다 — 등 뒤 공간이 통째로 빈 순간 */
export const RECOVERY_SPRINT_GAP = 18;

/** 공을 되찾은 직후 앞으로 치고 나가는 급함 — 역습에 붙는 몸. 최전방은 수비 뒤 공간으로 달린다 */
export const BURST_URGENCY: Record<WeightSlot, number> = {
  GK: 0,
  CB: 0,
  FB: 0.74,
  DM: 0.7,
  CM: 0.72,
  AM: 0.74,
  W: 0.68,
  CF: 0.78,
  ST: 0.8,
};

/** 치고 나갈 만큼 자리가 앞에 있어야 한다 (m) */
export const BURST_GAP = 9;

/** 오버래핑의 값이 공과의 가로 거리에 따라 줄어 0이 되는 거리 (m) — 공이 제 측면에 가까울수록 값지다 */
export const OVERLAP_FLANK = 30;

/** 공 가진 말보다 앞질러 서는 거리 (m)와 터치라인에서의 거리 (m) */
export const OVERLAP_AHEAD = 12;

export const OVERLAP_TOUCHLINE = 5;

/** 오버래핑의 급함 — 고강도 주행(19.8~25.2 km/h)으로 측면을 올라간다. 전력 질주는 드물다 */
export const OVERLAP_URGENCY = 0.7;

/** 오버래핑을 고르면 이만큼 (초) 다시 판단하지 않고 뛴다 — 한 번의 질주가 측면을 올라간다 */
export const OVERLAP_COMMIT_SECONDS = 2.5;

/** 최전방은 조직 수비에서 사람을 잡지 않는다 — 공을 되찾으면 나갈 자리를 지킨다 */
export const NON_MARKING_SLOTS: ReadonlySet<WeightSlot> = new Set(["CF", "ST"]);

// ── 공 없는 말의 후보점 (`step.ts` · live-match.md §5.2) ────────────────────────────
//
// 점수 = 상황 가치 + 역할 가산 + β·ln ρ + 관성, 선택은 온도 T의 softmax. 아래 값은 전부
// 그 점수의 눈금이다 — 자리 후보의 값이 기준이고, 다른 후보는 그보다 크면 더 자주 뽑힌다.

/**
 * 온도 — 능력치(공격 `offTheBall` · 수비 `positioning`)가 `OFFBALL_SKILL_TOP` 이상이면
 * `OFFBALL_TEMPERATURE_MIN`, `OFFBALL_SKILL_BOTTOM` 이하면 거기에 `OFFBALL_TEMPERATURE_SPAN`을
 * 더한 값. 선수 분포가 사는 구간에서 가파르게 — 60과 80이 다르게 움직여야 능력이 공간에 선다
 */
export const OFFBALL_TEMPERATURE_MIN = 0.06;

export const OFFBALL_TEMPERATURE_SPAN = 0.24;

export const OFFBALL_SKILL_TOP = 99;

export const OFFBALL_SKILL_BOTTOM = 0;

/** β — 로그 밀도가 점수에 들어가는 몫. 퍼짐 두 배 밖의 점(ln ρ ≈ −2)이 이 값의 두 배를 잃는다 */
export const OFFBALL_DENSITY_WEIGHT = 0.2;

/** 판단마다 히트맵에서 뽑아 후보에 넣는 점의 수와, 그 점의 값이 자리 후보보다 낮은 몫 */
export const OFFBALL_SAMPLES = 1;

export const OFFBALL_SAMPLE_DISCOUNT = 0.12;

/** 분포에서 뽑은 점이 서 있는 창 (초) — 창이 바뀔 때마다 새로 뽑는다 */
export const OFFBALL_WANDER_SECONDS = 30;

/**
 * 관성 — 지금 목표에서 이 거리 (m) 안의 후보에 더하는 값, 지난 판단과 같은 행동의 후보에
 * 더하는 값. 상황이 바뀌어야 다른 일로 옮긴다 — 판단마다 목표가 뒤집히면 말이 쉬지 않고 뛴다
 */
export const OFFBALL_INERTIA_RADIUS = 3;

export const OFFBALL_INERTIA = 0.5;

export const OFFBALL_INERTIA_KIND = 0.5;

/** 자리 후보의 값과 `hold` 성향이 더하는 값 */
export const SPOT_SHAPE = 0.3;

export const SPOT_HOLD = 0.3;

/** 역할 가산 — 성향이 중립(0.5)에서 벗어난 만큼 그 후보의 값에 더한다 */
export const SPOT_ROLE = 0.55;

/** 빈 공간의 눈금 (m) — 가장 가까운 상대가 이만큼 떨어지면 공간 값이 다 찬다 */
export const SPOT_SPACE_FULL = 10;

/** 위협(xT)의 눈금 — 이 값의 칸에서 위협 값이 다 찬다 (박스 앞 중앙 칸이 0.1) */
export const SPOT_THREAT_FULL = 0.1;

/** 지원 — 공 가진 동료에게서 이 거리 안이면 지원 후보를 세운다 (m) · 공간이 준 값 · 경로가 막혔을 때 남는 몫 */
export const SUPPORT_RANGE = 26;

export const SUPPORT_VALUE = 1;

export const SUPPORT_LANE_BLOCKED = 0.4;

/** 패스 경로가 막혔다고 보는 거리 (m) — 상대가 경로에서 이만큼 안에 있다 */
export const SUPPORT_LANE_WIDTH = 2;

/** 침투 — 라인 뒤 공간의 값과 그 공간이 다 차는 깊이 (m), 위협 값 */
export const RUN_VALUE = 0.1;

export const RUN_ROOM_FULL = 25;

export const RUN_THREAT = 0.05;

/** 침투를 세우는 공의 최소 깊이 (m)와 말의 최소 순간 여력 */
export const RUN_MIN_BALL_DEPTH = 35;

export const RUN_MIN_FUEL = 0.35;

/** 박스 진입 — 위협 값과 빈 공간 값 */
export const BOX_VALUE = 0.4;

export const BOX_SPACE = 0.05;

/** 오버래핑·폭 — 빈 공간 값과 위협 값 */
export const OVERLAP_VALUE = 0.4;

export const OVERLAP_THREAT = 0.15;

/** 수비 — 자리 후보의 값 */
export const SPOT_SHAPE_DEFEND = 0.35;

/** 마크 — 배정받은 상대의 골 쪽에 서는 값과 그 상대의 위협이 더하는 값, 서는 거리 (m) */
export const MARK_VALUE = 0.75;

export const MARK_THREAT = 0.4;

export const MARK_GOAL_SIDE = 2.2;

/** 마크 배정 — 공이 이 깊이보다 우리 쪽일 때 · 우리 골에서 이 거리 안의 상대만 (m) */
export const MARK_BALL_DEPTH = 63;

export const MARK_GOAL_RADIUS = 45;

/**
 * 마크 배정의 값 (m) — 거리 + 로그 밀도 1마다 이만큼. 그 값이 `MARK_COST_MAX`를 넘는
 * 수비는 맡지 않는다. 지금 맡은 수비는 `MARK_KEEP_METRES`만큼 덜 친다 — 목표가 상대의
 * 골 쪽 자리에서 `MARK_HOLD_SLACK` 안이면 맡고 있는 것이다
 */
export const MARK_ZONE_METRES = 3;

export const MARK_COST_MAX = 22;

export const MARK_KEEP_METRES = 4;

export const MARK_HOLD_SLACK = 1.5;

/** 슛 길목 — 공과 우리 골문을 잇는 선 위, 공에서 이 거리들 (m) · 값 */
export const LANE_STANDOFFS: readonly number[] = [6, 11];

export const LANE_VALUE = 0.9;

/** 길목에 이미 동료가 이 거리 안에 있으면 그 점의 값이 이 몫만 남는다 (m) */
export const LANE_OCCUPIED = 3;

export const LANE_OCCUPIED_SHARE = 0.2;

/** 존 커버 — 자리에서 우리 골 쪽으로 물러서는 거리 (m) · 공 쪽으로 좁히는 몫 · 값 */
export const COVER_DROP = 8;

export const COVER_NARROW = 0.3;

export const COVER_VALUE = 0.5;

/** 위험의 눈금 — 공이 우리 골문에서 이 거리 (m) 안이면 길목·커버의 값이 선다. 골문에서 1, 이 거리에서 0 */
export const DANGER_RANGE = 40;

/** 슛 길목·존 커버의 자리가 이만큼 (m) 넘게 남으면 위험만큼 서두른다 */
export const DANGER_RECOVERY_GAP = 5;

/** 골키퍼 — 공격 중 공 깊이 1m마다 나오는 거리 (m)와 그 상한 (m). 스위퍼 키퍼는 라인 뒤를 덮는다 */
export const KEEPER_ATTACK_ADVANCE = 0.25;

export const KEEPER_ATTACK_MAX_OUT = 25;

// ── 이동과 순간 여력 (`physics.ts`) ──────────────────────────────────────────────

/** 스피드 0의 최고 속도 (m/s) — 25 km/h */
export const TOP_SPEED_FLOOR = 6.95;

/** 스피드 99가 더하는 속도 (m/s) — 35 km/h까지 */
export const TOP_SPEED_SPAN = 2.75;

/** 가속 (m/s²) — 약 4초에 최고 속도에 닿는다 */
export const ACCELERATION = 2.3;

/** 감속은 가속보다 빠르다 */
export const DECELERATION = 5.5;

/** 경기 체력 0에서의 속도 배율 */
export const CONDITION_SPEED_FLOOR = 0.82;

/** 순간 여력 0에서의 속도 배율 */
export const FUEL_SPEED_FLOOR = 0.8;

/** 다친 말의 속도 배율 */
export const INJURED_SPEED = 0.25;

/** 공을 몰고 갈 때의 속도 배율 */
export const CARRY_SPEED = 0.82;

/** 행동마다의 급함 — 최고 속도의 몫. 자리 이동은 조깅, 압박·침투·되돌아가기는 전력 */
export const URGENCY: Record<LiveAction, number> = {
  shape: 0.42,
  press: 1,
  mark: 0.62,
  cover: 0.66,
  support: 0.55,
  run: 1,
  hold: 0.5,
  carry: CARRY_SPEED,
  chase: 1,
  sweep: 1,
};

/** 목표 앞에서 서는 거리 (m) — 자리 잡기는 정확한 점이 아니라 지역이다. 없는 행동은 점까지 간다 */
export const SETTLE: Partial<Record<LiveAction, number>> = {
  shape: 0.6,
  hold: 0.6,
  support: 0.8,
  cover: 0.8,
  mark: 0.4,
  press: 0.5,
};

/** 서두르지 않는 행동의 기본 걸음 (m/s)과 남은 거리 1m마다 더하는 속도 */
export const AMBLE_SPEED = 1.0;

export const AMBLE_PER_METRE = 0.35;

/** 순간 여력 — 고속 주행이 태우고 걷는 동안 찬다 (초당) */
export const FUEL_BURN_SPRINT = 0.11;

export const FUEL_BURN_HIGH = 0.055;

export const FUEL_RECOVER = 0.03;

/** 공의 비행 한 틱 — 땅볼은 마찰로 느려지고, 뜬 공은 포물선 높이를 갖는다 */
export const GROUND_FRICTION = 0.9;

// ── 팀 형태 (`shape.ts`) ─────────────────────────────────────────────────────

/** 공격 중 공을 따라 나가는 흐름을 `hold`가 줄이는 몫 — 수비 라인도 하프라인까지는 따라 오른다 */
export const ATTACK_FOLLOW_HOLD = 0.35;

/** 수비 블록이 공을 따라 오르내리는 배율 — `cover` 0에서의 값과 `cover` 1이 더하는 값 */
export const DEFEND_SHIFT_BASE = 0.7;

export const DEFEND_SHIFT_PER_COVER = 0.6;

/** 수비 형태가 공보다 앞에 서지 않는 여유 (m) — 첫 수비수만 공으로 간다 */
export const DEFEND_FRONT_MARGIN = 8;

/** 공격 형태가 상대 라인을 넘지 않는 여유 (m) — 라인과 나란히 선다 */
export const ATTACK_FRONT_MARGIN = 0.5;

// ── 히트맵 (`heatmap.ts` · live-match.md §3.3) ──────────────────────────────────────

/**
 * 히트맵의 성분 하나 — 형태 자리에서의 오프셋과 퍼짐 (m), 기본 가중치, 가중치가 반응하는 입력.
 *
 * 가중치 = `weight` × exp(`ball` × (공 깊이 − 52.5) ÷ 10 + Σ `tendency`의 기울기 × (성향 − 0.5))
 * × (`commit`이면 멘탈리티 배율). 성분들의 가중치는 합이 1이 되게 나눈다.
 */
export interface HeatComponent {
  /** 깊이 오프셋 — 상대 골 쪽이 + */
  depth: number;
  /** 가로 오프셋 — 제 측면의 터치라인 쪽이 +. 중앙에 선 말에게는 0이 된다 */
  lateral: number;
  back: number;
  ahead: number;
  side: number;
  weight: number;
  /** 공 깊이 10m마다 가중치의 로짓이 오르는 몫 — 공이 전진할수록 무거워지면 + */
  ball?: number;
  tendency?: Partial<Record<TendencyAxis, number>>;
  /** 멘탈리티의 가담 배율(`commit`)을 가중치에 곱한다 */
  commit?: boolean;
}

/** 자리 묶음 × 국면(공격 / 수비)의 성분 — 첫 성분이 형태 자리 그대로의 중심이다 */
export const HEATMAP: Record<WeightSlot, { attack: HeatComponent[]; defend: HeatComponent[] }> = {
  GK: {
    attack: [{ depth: 0, lateral: 0, back: 3, ahead: 4, side: 5, weight: 1 }],
    defend: [{ depth: 0, lateral: 0, back: 3, ahead: 4, side: 5, weight: 1 }],
  },
  CB: {
    attack: [
      { depth: 0, lateral: 0, back: 7, ahead: 8, side: 8, weight: 1 },
      {
        depth: 12,
        lateral: 0,
        back: 4,
        ahead: 10,
        side: 8,
        weight: 0.12,
        tendency: { advance: 3 },
      },
    ],
    defend: [
      { depth: 0, lateral: 0, back: 8, ahead: 6, side: 8, weight: 1 },
      {
        depth: -5,
        lateral: -3,
        back: 4,
        ahead: 5,
        side: 6,
        weight: 0.2,
        ball: -0.8,
        tendency: { cover: 2 },
      },
    ],
  },
  FB: {
    attack: [
      // 제자리 — 공이 뒤에 있을수록 무겁다
      {
        depth: -4,
        lateral: 0,
        back: 10,
        ahead: 8,
        side: 7,
        weight: 0.8,
        ball: -0.4,
        tendency: { cover: 2 },
      },
      // 가담 — 측면 높은 곳
      {
        depth: 26,
        lateral: 5,
        back: 10,
        ahead: 16,
        side: 6,
        weight: 1.1,
        ball: 0.6,
        tendency: { advance: 4, width: 2 },
        commit: true,
      },
      // 측면 끝 — 상대 마무리 지역의 골라인 근처. 윙백이 크로스를 올리는 자리
      {
        depth: 38,
        lateral: 7,
        back: 8,
        ahead: 12,
        side: 5,
        weight: 0.35,
        ball: 0.9,
        tendency: { advance: 5, width: 2 },
        commit: true,
      },
      // 안쪽 — 인버티드 풀백의 중원 자리
      { depth: 2, lateral: -16, back: 8, ahead: 10, side: 7, weight: 0.1, tendency: { inside: 6 } },
    ],
    defend: [
      { depth: 0, lateral: 0, back: 10, ahead: 8, side: 8, weight: 1 },
      { depth: -6, lateral: -6, back: 6, ahead: 6, side: 7, weight: 0.2, ball: -0.8 },
      { depth: 10, lateral: 0, back: 6, ahead: 10, side: 7, weight: 0.15, tendency: { press: 3 } },
    ],
  },
  DM: {
    attack: [
      { depth: 0, lateral: 0, back: 8, ahead: 10, side: 10, weight: 1 },
      {
        depth: 14,
        lateral: 0,
        back: 8,
        ahead: 10,
        side: 10,
        weight: 0.2,
        tendency: { advance: 3 },
        commit: true,
      },
    ],
    defend: [
      { depth: 0, lateral: 0, back: 10, ahead: 8, side: 11, weight: 1 },
      {
        depth: -8,
        lateral: 0,
        back: 6,
        ahead: 6,
        side: 10,
        weight: 0.3,
        ball: -0.6,
        tendency: { cover: 3 },
      },
    ],
  },
  CM: {
    attack: [
      { depth: 0, lateral: 0, back: 10, ahead: 10, side: 11, weight: 1 },
      {
        depth: 16,
        lateral: 0,
        back: 8,
        ahead: 12,
        side: 12,
        weight: 0.35,
        ball: 0.3,
        tendency: { advance: 3, boxPresence: 2 },
        commit: true,
      },
    ],
    defend: [
      { depth: 0, lateral: 0, back: 10, ahead: 9, side: 12, weight: 1 },
      {
        depth: -10,
        lateral: 0,
        back: 6,
        ahead: 6,
        side: 12,
        weight: 0.3,
        ball: -0.6,
        tendency: { cover: 2 },
      },
      { depth: 8, lateral: 0, back: 6, ahead: 8, side: 10, weight: 0.15, tendency: { press: 3 } },
    ],
  },
  AM: {
    attack: [
      { depth: 0, lateral: 0, back: 10, ahead: 12, side: 12, weight: 1 },
      {
        depth: 12,
        lateral: 0,
        back: 6,
        ahead: 10,
        side: 10,
        weight: 0.45,
        ball: 0.4,
        tendency: { boxPresence: 3, runBehind: 2 },
        commit: true,
      },
    ],
    defend: [
      { depth: 0, lateral: 0, back: 8, ahead: 9, side: 12, weight: 1 },
      {
        depth: -12,
        lateral: 0,
        back: 6,
        ahead: 6,
        side: 12,
        weight: 0.2,
        ball: -0.5,
        tendency: { cover: 3 },
      },
    ],
  },
  W: {
    attack: [
      // 폭 — 터치라인 쪽
      { depth: 0, lateral: 4, back: 10, ahead: 12, side: 7, weight: 1, tendency: { width: 3 } },
      // 안쪽 — 하프 스페이스에서 박스로
      {
        depth: 8,
        lateral: -14,
        back: 8,
        ahead: 12,
        side: 8,
        weight: 0.4,
        ball: 0.3,
        tendency: { inside: 5, boxPresence: 2 },
        commit: true,
      },
    ],
    defend: [
      { depth: 0, lateral: 0, back: 10, ahead: 9, side: 8, weight: 1 },
      {
        depth: -16,
        lateral: 0,
        back: 8,
        ahead: 6,
        side: 8,
        weight: 0.3,
        ball: -0.6,
        tendency: { cover: 3 },
      },
    ],
  },
  CF: {
    attack: [
      { depth: 0, lateral: 0, back: 12, ahead: 10, side: 11, weight: 1 },
      {
        depth: -12,
        lateral: 0,
        back: 8,
        ahead: 8,
        side: 12,
        weight: 0.25,
        tendency: { dropDeep: 4 },
      },
      {
        depth: 10,
        lateral: 0,
        back: 5,
        ahead: 10,
        side: 9,
        weight: 0.4,
        ball: 0.4,
        tendency: { boxPresence: 3 },
        commit: true,
      },
    ],
    defend: [{ depth: 0, lateral: 0, back: 6, ahead: 10, side: 11, weight: 1 }],
  },
  ST: {
    attack: [
      { depth: 0, lateral: 0, back: 8, ahead: 10, side: 10, weight: 1 },
      {
        depth: 10,
        lateral: 0,
        back: 5,
        ahead: 10,
        side: 8,
        weight: 0.5,
        ball: 0.5,
        tendency: { boxPresence: 3, runBehind: 2 },
        commit: true,
      },
    ],
    defend: [{ depth: 0, lateral: 0, back: 5, ahead: 10, side: 10, weight: 1 }],
  },
};

/** 옆 퍼짐을 `roam`이 넓히는 몫 — 중립(0.5)에서 1만큼 벗어나면 이만큼 */
export const HEATMAP_ROAM_REACH = 0.8;

/** 세트피스 성분 — 배치 자리 둘레의 퍼짐 (m)과 킥 순간의 가중치 (나머지 성분의 합이 1일 때) */
export const HEATMAP_SET_PIECE_SPREAD = 4;

export const HEATMAP_SET_PIECE_WEIGHT = 3;

/** 밀도의 바닥 — 로그를 잴 때만 더한다. 먼 점의 로그 밀도가 이 값의 로그에서 멈춘다 */
export const HEATMAP_DENSITY_FLOOR = 1e-4;

// ── 전술 → 말의 파라미터 (`params.ts`) ────────────────────────────────────────────

/** 형태 오차의 기본 (m) — 적응도 100·`cohesion` 1에서 */
export const SHAPE_NOISE_BASE = 2.2;

/** 압박 한 칸이 압박 반경을 넓히는 몫 */
export const PRESS_REACH_PER_STEP = 0.5;

/** 압박 한 칸이 블록의 앞뒤 추종을 늘리는 몫 */
export const BLOCK_FOLLOW_PER_STEP = 0.16;

/** 압박 한 칸이 블록의 공 쪽 쏠림을 늘리는 몫 */
export const BLOCK_SLIDE_PER_STEP = 0.05;

/** 멘탈리티 한 칸이 전진의 값(위협 증가)을 키우는 몫 */
export const AMBITION_PER_MENTALITY_STEP = 0.15;

/** 멘탈리티 한 칸이 슈팅을 고르는 문턱 xG를 내리는 폭 — 공격적인 팀은 반 박자 먼저 찬다 */
export const SHOT_THRESHOLD_PER_MENTALITY_STEP = 0.024;

/**
 * 멘탈리티 중립에서 슈팅을 고르는 최소 xG — 실측은 팀 슈팅 12.6 · 슈팅당 xG 0.12다. 문턱이
 * 높으면 좋은 기회만 차서 슈팅이 적고 슈팅당 xG가 부푼다
 */
export const SHOT_THRESHOLD_NEUTRAL = 0.118;

/** 멘탈리티 한 칸이 공격 가담(형태의 전진·침투·박스 진입)에 더하는 배율 */
export const COMMIT_PER_MENTALITY_STEP = 0.2;

// ── 슈팅 xG (`xg.ts`) ───────────────────────────────────────────────────────

/**
 * 기준 — 페널티를 뺀 일반 플레이 슈팅이 실제로 들어가는 비율에 기록의 xG 합이 서는 값.
 * 이 눈금을 옮기면 `params.ts`의 `shotThreshold`도 같은 비로 옮겨야 선수의 슈팅 선택이 그대로다
 */
export const XG_BASE = 0.407;

export const XG_DISTANCE_SCALE = 7.5;

export const XG_ANGLE_REFERENCE = 0.62;

export const XG_PRESSURE = 0.3;

/** 길목의 상대 하나가 xG를 나누는 몫 */
export const XG_BLOCKER = 0.7;

export const XG_HEADER = 0.6;

export const XG_ORIGIN: Record<ShotContext["origin"], number> = {
  open: 1,
  through: 1.2,
  cross: 0.85,
  set_piece: 0.8,
  rebound: 1.15,
  counter: 1.15,
};

/** 슈팅 사거리 (m) — 이보다 멀면 슈팅을 선택지에 넣지 않는다 */
export const SHOT_RANGE = 30;
