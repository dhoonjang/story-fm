import type { RealPlayerSeed } from "./epl-players";

/**
 * 이적 시장 전용 리그의 실선수 시드 — 사우디 프로 리그 · MLS.
 *
 * **2026-08 시점의 어림 스냅샷**이다. 이 클럽들은 경기를 하지 않으므로 스쿼드
 * 전체가 필요 없고, "감독이 데려올 만한 이름"만 시드로 둔다. 나머지 인원은
 * 절차 생성으로 채운다(`fallbackEntries`).
 *
 * ⚠️ 라이선스·정확도 부채 (data-sourcing.md §7)
 * - 실명·능력치는 5대 리그 시드와 같은 부채를 진다. 가명 전환 때 함께 처리한다.
 * - 명단·이적 시점은 5대 리그 시드만큼 교차 검증되지 않았다. 여기 이름들은
 *   "그 무렵 그 리그로 떠난 것으로 알려진 선수"이고, 실제 소속 클럽·계약 상태와
 *   어긋날 수 있다. 세계관상 인게임 연도는 가상으로 흐르므로 게임을 깨지는 않지만,
 *   정식 데이터 정비 때 다시 맞춰야 한다.
 *
 * 능력치는 **떠날 당시가 아니라 지금**의 값이다 — 나이가 든 만큼 깎여 있다.
 * 그래야 "이름값은 여전한데 예전 같지 않다"는 판단이 감독의 몫이 된다.
 */

/** 사우디 프로 리그 */
export const SAUDI_SQUADS: Record<string, readonly RealPlayerSeed[]> = {
  alnassr: [
    { nameEn: "Cristiano Ronaldo", nameKo: "크리스티아누 호날두", birthdate: "1985-02-05", position: "ST", positionGroup: "FW", pace: 72, shooting: 88, passing: 72, dribbling: 76, defending: 30, physical: 74, height: 187, weight: 84, foot: "R", potential: 88, weeklyWage: 3400000 },
    { nameEn: "Sadio Mane", nameKo: "사디오 마네", birthdate: "1992-04-10", position: "LW", positionGroup: "FW", pace: 80, shooting: 80, passing: 76, dribbling: 82, defending: 42, physical: 74, height: 175, weight: 69, foot: "R", potential: 84, weeklyWage: 650000 },
    { nameEn: "Marcelo Brozovic", nameKo: "마르첼로 브로조비치", birthdate: "1992-11-16", position: "CDM", positionGroup: "MF", pace: 62, shooting: 70, passing: 84, dribbling: 78, defending: 76, physical: 70, height: 181, weight: 68, foot: "R", potential: 84, weeklyWage: 480000 },
  ],
  alhilal: [
    { nameEn: "Ruben Neves", nameKo: "후벵 네베스", birthdate: "1997-03-13", position: "CDM", positionGroup: "MF", pace: 60, shooting: 78, passing: 85, dribbling: 76, defending: 78, physical: 76, height: 180, weight: 80, foot: "R", potential: 86, weeklyWage: 460000 },
    { nameEn: "Kalidou Koulibaly", nameKo: "칼리두 쿨리발리", birthdate: "1991-06-20", position: "CB", positionGroup: "DF", pace: 68, shooting: 42, passing: 66, dribbling: 60, defending: 84, physical: 86, height: 186, weight: 89, foot: "R", potential: 86, weeklyWage: 520000 },
    { nameEn: "Joao Cancelo", nameKo: "주앙 칸셀루", birthdate: "1994-05-27", position: "RB", positionGroup: "DF", pace: 78, shooting: 68, passing: 82, dribbling: 82, defending: 74, physical: 68, height: 182, weight: 74, foot: "R", potential: 86, weeklyWage: 420000 },
    { nameEn: "Aleksandar Mitrovic", nameKo: "알렉산다르 미트로비치", birthdate: "1994-09-16", position: "ST", positionGroup: "FW", pace: 62, shooting: 84, passing: 62, dribbling: 66, defending: 38, physical: 88, height: 189, weight: 82, potential: 85, weeklyWage: 380000 },
  ],
  alittihad: [
    { nameEn: "Karim Benzema", nameKo: "카림 벤제마", birthdate: "1987-12-19", position: "CF", positionGroup: "FW", pace: 66, shooting: 86, passing: 82, dribbling: 82, defending: 34, physical: 70, height: 185, weight: 81, foot: "R", potential: 88, weeklyWage: 1700000 },
    { nameEn: "N'Golo Kante", nameKo: "은골로 캉테", birthdate: "1991-03-29", position: "CDM", positionGroup: "MF", pace: 72, shooting: 62, passing: 78, dribbling: 78, defending: 86, physical: 76, height: 168, weight: 68, potential: 86, weeklyWage: 900000 },
    { nameEn: "Fabinho", nameKo: "파비뉴", birthdate: "1993-10-23", position: "CDM", positionGroup: "MF", pace: 62, shooting: 64, passing: 76, dribbling: 70, defending: 82, physical: 80, height: 188, weight: 78, foot: "R", weakFoot: 2, potential: 84, weeklyWage: 340000 },
  ],
  alahli: [
    { nameEn: "Riyad Mahrez", nameKo: "리야드 마레즈", birthdate: "1991-02-21", position: "RW", positionGroup: "FW", pace: 74, shooting: 80, passing: 82, dribbling: 86, defending: 36, physical: 58, height: 179, weight: 67, foot: "L", potential: 85, weeklyWage: 520000 },
    { nameEn: "Edouard Mendy", nameKo: "에두아르 멘디", birthdate: "1992-03-01", position: "GK", positionGroup: "GK", pace: 44, shooting: 20, passing: 52, dribbling: 40, defending: 24, physical: 74, goalkeeping: 82, height: 197, weight: 89, foot: "R", weakFoot: 2, potential: 84, weeklyWage: 340000 },
    { nameEn: "Roberto Firmino", nameKo: "호베르투 피르미누", birthdate: "1991-10-02", position: "CF", positionGroup: "FW", pace: 68, shooting: 78, passing: 80, dribbling: 82, defending: 48, physical: 72, height: 181, weight: 76, potential: 84, weeklyWage: 300000 },
  ],
};

/** 메이저 리그 사커 */
export const MLS_SQUADS: Record<string, readonly RealPlayerSeed[]> = {
  intermiami: [
    { nameEn: "Lionel Messi", nameKo: "리오넬 메시", birthdate: "1987-06-24", position: "RW", positionGroup: "FW", pace: 72, shooting: 86, passing: 90, dribbling: 90, defending: 28, physical: 60, height: 170, weight: 72, foot: "L", potential: 90, weeklyWage: 1200000 },
    { nameEn: "Sergio Busquets", nameKo: "세르히오 부스케츠", birthdate: "1988-07-16", position: "CDM", positionGroup: "MF", pace: 44, shooting: 58, passing: 84, dribbling: 72, defending: 76, physical: 66, height: 189, weight: 76, foot: "R", weakFoot: 3, potential: 82, weeklyWage: 170000 },
    { nameEn: "Jordi Alba", nameKo: "조르디 알바", birthdate: "1989-03-21", position: "LB", positionGroup: "DF", pace: 74, shooting: 62, passing: 80, dribbling: 76, defending: 72, physical: 62, height: 170, weight: 68, foot: "L", weakFoot: 3, potential: 82, weeklyWage: 150000 },
  ],
  lafc: [
    { nameEn: "Son Heung-min", nameKo: "손흥민", birthdate: "1992-07-08", position: "LW", positionGroup: "FW", pace: 82, shooting: 84, passing: 78, dribbling: 82, defending: 42, physical: 70, height: 183, weight: 78, potential: 87, weeklyWage: 250000 },
    { nameEn: "Hugo Lloris", nameKo: "위고 요리스", birthdate: "1986-12-26", position: "GK", positionGroup: "GK", pace: 46, shooting: 20, passing: 58, dribbling: 44, defending: 22, physical: 62, goalkeeping: 78, height: 188, weight: 82, foot: "L", weakFoot: 1, potential: 82, weeklyWage: 110000 },
  ],
  lagalaxy: [
    { nameEn: "Marco Reus", nameKo: "마르코 로이스", birthdate: "1989-05-31", position: "CAM", positionGroup: "MF", pace: 68, shooting: 80, passing: 82, dribbling: 82, defending: 36, physical: 58, height: 180, weight: 71, foot: "R", potential: 84, weeklyWage: 130000 },
  ],
  torontofc: [
    { nameEn: "Lorenzo Insigne", nameKo: "로렌초 인시녜", birthdate: "1991-06-04", position: "LW", positionGroup: "FW", pace: 72, shooting: 78, passing: 80, dribbling: 82, defending: 34, physical: 54, height: 163, weight: 59, potential: 83, weeklyWage: 180000 },
  ],
};

export const MARKET_LEAGUE_SQUADS: Record<string, readonly RealPlayerSeed[]> = {
  ...SAUDI_SQUADS,
  ...MLS_SQUADS,
};
