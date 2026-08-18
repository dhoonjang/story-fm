import type { RealPlayerSeed } from "./epl-players";

/**
 * 이적 시장 전용 리그의 실선수 시드 — 사우디 프로 리그 · MLS.
 *
 * **2026-08-15 스냅샷**이다. 이 클럽들은 경기를 하지 않으므로 스쿼드 전체가
 * 필요 없고, "감독이 데려올 만한 이름"만 시드로 둔다. 나머지 인원은 절차
 * 생성으로 채운다(`fallbackEntries`).
 *
 * 명단은 5대 리그 시드와 같은 경로로 맞췄다 — 위키백과 구단 문서의 현 스쿼드에
 * 실제로 있는 선수만 남기고, 능력치·신체는 EA FC 27 공개 등급에서 가져왔다.
 * 그 대조에서 일곱 명이 빠졌다: 브로조비치·마레즈(계약 만료) · 조르디 알바(은퇴) ·
 * 미트로비치(알라이얀) · 캉테(페네르바흐체) · 피르미누(알사드) · 인시녜(삼프도리아).
 * 벤제마는 알이티하드에서 알힐랄로 옮겼다.
 *
 * ⚠️ 라이선스 부채 (sources.md §7): 실명·능력치는 5대 리그 시드와 같은
 * 부채를 진다. 가명 전환 때 함께 처리한다.
 *
 * 능력치는 **떠날 당시가 아니라 지금**의 값이다 — 나이가 든 만큼 깎여 있다.
 * 그래야 "이름값은 여전한데 예전 같지 않다"는 판단이 감독의 몫이 된다.
 */

/** 사우디 프로 리그 */
export const SAUDI_SQUADS: Record<string, readonly RealPlayerSeed[]> = {
  alnassr: [
    { nameEn: "Bento", squadNumber: 24, nameKo: "벤투", birthdate: "1999-06-10", wikidataId: "Q98265925", position: "GK", positionGroup: "GK", pace: 40, shooting: 58, passing: 76, dribbling: 16, defending: 5, physical: 58, goalkeeping: 78, height: 190, weight: 80, foot: "R", weakFoot: 2, potential: 82 },
    { nameEn: "Iñigo Martínez", squadNumber: 26, nameKo: "이니고 마르티네스", birthdate: "1991-05-17", wikidataId: "Q1028020", position: "CB", positionGroup: "DF", pace: 71, shooting: 57, passing: 72, dribbling: 67, defending: 84, physical: 80, height: 182, weight: 76, foot: "L", weakFoot: 3, potential: 84 },
    { nameEn: "Mohamed Simakan", squadNumber: 3, nameKo: "모하메드 시마캉", birthdate: "2000-05-03", wikidataId: "Q60147292", position: "CB", positionGroup: "DF", pace: 76, shooting: 43, passing: 65, dribbling: 69, defending: 82, physical: 82, height: 187, weight: 82, foot: "R", weakFoot: 3, potential: 85 },
    { nameEn: "João Félix", squadNumber: 79, nameKo: "주앙 펠릭스", birthdate: "1999-11-10", wikidataId: "Q27049064", position: "CAM", positionGroup: "MF", pace: 77, shooting: 81, passing: 78, dribbling: 83, defending: 45, physical: 66, height: 181, weight: 70, foot: "R", weakFoot: 4, potential: 84 },
    { nameEn: "Sadio Mané", squadNumber: 10, nameKo: "사디오 마네", birthdate: "1992-04-10", wikidataId: "Q209942", position: "LM", positionGroup: "MF", pace: 82, shooting: 81, passing: 78, dribbling: 85, defending: 44, physical: 75, height: 174, weight: 69, foot: "R", weakFoot: 4, potential: 83, weeklyWage: 650000 },
    { nameEn: "Kingsley Coman", squadNumber: 21, nameKo: "킹슬리 코망", birthdate: "1996-06-13", wikidataId: "Q6413296", position: "LM", positionGroup: "MF", pace: 87, shooting: 74, passing: 78, dribbling: 87, defending: 30, physical: 61, height: 181, weight: 75, foot: "R", weakFoot: 3, potential: 83 },
    { nameEn: "Cristiano Ronaldo", squadNumber: 7, nameKo: "크리스티아누 호날두", birthdate: "1985-02-05", wikidataId: "Q11571", position: "ST", positionGroup: "FW", pace: 76, shooting: 88, passing: 76, dribbling: 80, defending: 34, physical: 76, height: 187, weight: 85, foot: "R", weakFoot: 4, potential: 88, weeklyWage: 3400000 },
  ],
  alhilal: [
    { nameEn: "Yassine Bounou", squadNumber: 37, nameKo: "야신 부누", birthdate: "1991-04-05", wikidataId: "Q3571952", position: "GK", positionGroup: "GK", pace: 38, shooting: 57, passing: 76, dribbling: 12, defending: 20, physical: 69, goalkeeping: 82, height: 195, weight: 78, foot: "L", weakFoot: 2, potential: 84 },
    { nameEn: "João Cancelo", squadNumber: 20, nameKo: "주앙 칸셀루", birthdate: "1994-05-27", wikidataId: "Q6298063", position: "RB", positionGroup: "DF", pace: 83, shooting: 73, passing: 84, dribbling: 84, defending: 78, physical: 71, height: 182, weight: 74, foot: "R", weakFoot: 4, potential: 85, weeklyWage: 420000 },
    { nameEn: "Théo Hernandez", squadNumber: 19, nameKo: "테오 에르난데스", birthdate: "1997-10-06", wikidataId: "Q23703372", position: "LB", positionGroup: "DF", pace: 90, shooting: 77, passing: 78, dribbling: 83, defending: 79, physical: 83, height: 184, weight: 81, foot: "L", weakFoot: 3, potential: 89 },
    { nameEn: "Kalidou Koulibaly", squadNumber: 3, nameKo: "칼리두 쿨리발리", birthdate: "1991-06-20", wikidataId: "Q3192187", position: "CB", positionGroup: "DF", pace: 74, shooting: 48, passing: 62, dribbling: 65, defending: 82, physical: 84, height: 186, weight: 89, foot: "R", weakFoot: 4, potential: 85, weeklyWage: 520000 },
    { nameEn: "Rúben Neves", squadNumber: 8, nameKo: "후벵 네베스", birthdate: "1997-03-13", wikidataId: "Q17486599", position: "CDM", positionGroup: "MF", pace: 57, shooting: 75, passing: 87, dribbling: 78, defending: 78, physical: 77, height: 180, weight: 83, foot: "R", weakFoot: 4, potential: 87, weeklyWage: 460000 },
    { nameEn: "Sergej Milinković-Savić", squadNumber: 22, nameKo: "세르게이 밀린코비치사비치", birthdate: "1995-02-27", wikidataId: "Q15673000", position: "CM", positionGroup: "MF", pace: 62, shooting: 80, passing: 82, dribbling: 81, defending: 78, physical: 88, height: 192, weight: 95, foot: "R", weakFoot: 5, potential: 89 },
    { nameEn: "Malcom", squadNumber: 10, nameKo: "말콤", birthdate: "1997-02-26", wikidataId: "Q16745198", position: "CAM", positionGroup: "MF", pace: 88, shooting: 78, passing: 79, dribbling: 84, defending: 43, physical: 73, height: 172, weight: 74, foot: "L", weakFoot: 3, potential: 84 },
    { nameEn: "Crysencio Summerville", squadNumber: 38, nameKo: "크리센시오 서머빌", birthdate: "2001-10-30", wikidataId: "Q60664537", position: "LM", positionGroup: "MF", pace: 89, shooting: 74, passing: 70, dribbling: 82, defending: 36, physical: 55, height: 169, weight: 64, foot: "R", weakFoot: 3, potential: 82 },
    { nameEn: "Karim Benzema", squadNumber: 9, nameKo: "카림 벤제마", birthdate: "1987-12-19", wikidataId: "Q1912", position: "ST", positionGroup: "FW", pace: 75, shooting: 84, passing: 81, dribbling: 83, defending: 38, physical: 77, height: 185, weight: 81, foot: "R", weakFoot: 4, potential: 86, weeklyWage: 1700000 },
    { nameEn: "Darwin Núñez", squadNumber: 7, nameKo: "다르윈 누녜스", birthdate: "1999-06-24", wikidataId: "Q46372260", position: "ST", positionGroup: "FW", pace: 88, shooting: 77, passing: 72, dribbling: 74, defending: 49, physical: 82, height: 187, weight: 81, foot: "R", weakFoot: 3, potential: 85 },
  ],
  alittihad: [
    { nameEn: "Predrag Rajković", squadNumber: 1, nameKo: "프레드라그 라이코비치", birthdate: "1995-10-31", wikidataId: "Q10556299", position: "GK", positionGroup: "GK", pace: 28, shooting: 57, passing: 72, dribbling: 18, defending: 11, physical: 66, goalkeeping: 77, height: 191, weight: 85, foot: "R", weakFoot: 2, potential: 78 },
    { nameEn: "Danilo Pereira", squadNumber: 2, nameKo: "다닐루 페레이라", birthdate: "1991-09-09", wikidataId: "Q766289", position: "CB", positionGroup: "DF", pace: 49, shooting: 64, passing: 68, dribbling: 71, defending: 82, physical: 84, height: 188, weight: 83, foot: "R", weakFoot: 3, potential: 82 },
    { nameEn: "Moussa Diaby", squadNumber: 19, nameKo: "무사 디아비", birthdate: "1999-07-07", wikidataId: "Q51855361", position: "RM", positionGroup: "MF", pace: 95, shooting: 72, passing: 78, dribbling: 85, defending: 44, physical: 54, height: 170, weight: 67, foot: "L", weakFoot: 3, potential: 86 },
    { nameEn: "Steven Bergwijn", squadNumber: 34, nameKo: "스테번 베르흐베인", birthdate: "1997-10-08", wikidataId: "Q17496653", position: "LM", positionGroup: "MF", pace: 80, shooting: 78, passing: 76, dribbling: 83, defending: 41, physical: 71, height: 171, weight: 78, foot: "R", weakFoot: 1, potential: 80 },
    { nameEn: "Houssem Aouar", squadNumber: 10, nameKo: "우셈 아와르", birthdate: "1998-06-30", wikidataId: "Q27927442", position: "CAM", positionGroup: "MF", pace: 64, shooting: 74, passing: 75, dribbling: 81, defending: 65, physical: 66, height: 175, weight: 70, foot: "R", weakFoot: 3, potential: 80 },
    { nameEn: "Youssef En-Nesyri", squadNumber: 21, nameKo: "유세프 엔네시리", birthdate: "1997-06-01", wikidataId: "Q26262219", position: "ST", positionGroup: "FW", pace: 78, shooting: 81, passing: 62, dribbling: 70, defending: 35, physical: 80, height: 188, weight: 78, foot: "L", weakFoot: 3, potential: 81 },
  ],
  alahli: [
    { nameEn: "Édouard Mendy", squadNumber: 16, nameKo: "에두아르 멘디", birthdate: "1992-03-01", wikidataId: "Q27736107", position: "GK", positionGroup: "GK", pace: 34, shooting: 56, passing: 77, dribbling: 31, defending: 10, physical: 72, goalkeeping: 81, height: 197, weight: 86, foot: "R", weakFoot: 2, potential: 83, weeklyWage: 340000 },
    { nameEn: "Roger Ibañez", squadNumber: 3, nameKo: "호제르 이바녜스", birthdate: "1998-11-23", wikidataId: "Q55363875", position: "CB", positionGroup: "DF", pace: 87, shooting: 34, passing: 55, dribbling: 65, defending: 82, physical: 85, height: 185, weight: 73, foot: "R", weakFoot: 2, potential: 85 },
    { nameEn: "Merih Demiral", squadNumber: 28, nameKo: "메리흐 데미랄", birthdate: "1998-03-05", wikidataId: "Q29047921", position: "CB", positionGroup: "DF", pace: 70, shooting: 41, passing: 52, dribbling: 60, defending: 80, physical: 81, height: 190, weight: 86, foot: "R", weakFoot: 2, potential: 80 },
    { nameEn: "Francisco Trincão", squadNumber: 7, nameKo: "프란시스쿠 트린캉", birthdate: "1999-12-29", wikidataId: "Q24084271", position: "CAM", positionGroup: "MF", pace: 80, shooting: 81, passing: 80, dribbling: 84, defending: 40, physical: 71, height: 184, weight: 74, foot: "L", weakFoot: 2, potential: 86 },
    { nameEn: "Enzo Millot", squadNumber: 10, nameKo: "엔조 미요", birthdate: "2002-07-17", wikidataId: "Q66424662", position: "CAM", positionGroup: "MF", pace: 74, shooting: 70, passing: 75, dribbling: 83, defending: 61, physical: 56, height: 174, weight: 66, foot: "L", weakFoot: 2, potential: 82 },
    { nameEn: "Firas Al-Buraikan", squadNumber: 9, nameKo: "피라스 알부라이칸", birthdate: "2000-05-14", wikidataId: "Q30082508", position: "LM", positionGroup: "MF", pace: 80, shooting: 71, passing: 63, dribbling: 71, defending: 48, physical: 74, height: 185, weight: 79, foot: "L", weakFoot: 3, potential: 76 },
    { nameEn: "Ivan Toney", squadNumber: 17, nameKo: "이반 토니", birthdate: "1996-03-16", wikidataId: "Q16239819", position: "ST", positionGroup: "FW", pace: 73, shooting: 83, passing: 71, dribbling: 76, defending: 52, physical: 83, height: 187, weight: 76, foot: "R", weakFoot: 3, potential: 84 },
  ],
};

/** 메이저 리그 사커 */
export const MLS_SQUADS: Record<string, readonly RealPlayerSeed[]> = {
  intermiami: [
    { nameEn: "Rodrigo De Paul", squadNumber: 7, nameKo: "로드리고 데 파울", birthdate: "1994-05-24", wikidataId: "Q6110670", position: "CM", positionGroup: "MF", pace: 75, shooting: 77, passing: 83, dribbling: 83, defending: 75, physical: 83, height: 180, weight: 70, foot: "R", weakFoot: 3, potential: 86 },
    { nameEn: "Casemiro", squadNumber: 5, nameKo: "카세미루", birthdate: "1992-02-23", wikidataId: "Q616664", position: "CDM", positionGroup: "MF", pace: 36, shooting: 74, passing: 78, dribbling: 69, defending: 81, physical: 79, height: 185, weight: 84, foot: "R", weakFoot: 3, potential: 83 },
    { nameEn: "Lionel Messi", squadNumber: 10, nameKo: "리오넬 메시", birthdate: "1987-06-24", wikidataId: "Q615", position: "RW", positionGroup: "FW", pace: 76, shooting: 84, passing: 84, dribbling: 89, defending: 33, physical: 64, height: 169, weight: 67, foot: "L", weakFoot: 4, potential: 87, weeklyWage: 1200000 },
    { nameEn: "Luis Suárez", squadNumber: 9, nameKo: "루이스 수아레스", birthdate: "1987-01-24", wikidataId: "Q26517", position: "ST", positionGroup: "FW", pace: 51, shooting: 81, passing: 74, dribbling: 76, defending: 41, physical: 75, height: 182, weight: 86, foot: "R", weakFoot: 4, potential: 80 },
  ],
  lafc: [
    { nameEn: "Hugo Lloris", squadNumber: 1, nameKo: "위고 요리스", birthdate: "1986-12-26", wikidataId: "Q1907", position: "GK", positionGroup: "GK", pace: 54, shooting: 52, passing: 69, dribbling: 29, defending: 24, physical: 39, goalkeeping: 75, height: 188, weight: 82, foot: "L", weakFoot: 1, potential: 76, weeklyWage: 110000 },
    { nameEn: "Son Heung-min", squadNumber: 7, nameKo: "손흥민", birthdate: "1992-07-08", wikidataId: "Q439722", position: "LW", positionGroup: "FW", pace: 83, shooting: 84, passing: 81, dribbling: 83, defending: 42, physical: 73, height: 183, weight: 78, foot: "R", weakFoot: 5, potential: 86, weeklyWage: 250000 },
    { nameEn: "Denis Bouanga", squadNumber: 99, nameKo: "드니 부앙가", birthdate: "1994-11-11", wikidataId: "Q21620919", position: "LW", positionGroup: "FW", pace: 85, shooting: 81, passing: 71, dribbling: 81, defending: 38, physical: 79, height: 180, weight: 71, foot: "R", weakFoot: 4, potential: 81 },
  ],
  lagalaxy: [
    { nameEn: "Maya Yoshida", squadNumber: 4, nameKo: "요시다 마야", birthdate: "1988-08-24", wikidataId: "Q248141", position: "CB", positionGroup: "DF", pace: 46, shooting: 41, passing: 54, dribbling: 62, defending: 67, physical: 74, height: 189, weight: 90, foot: "R", weakFoot: 4, potential: 68 },
    { nameEn: "Riqui Puig", squadNumber: 10, nameKo: "리키 푸이그", birthdate: "1999-08-13", wikidataId: "Q50315237", position: "CM", positionGroup: "MF", pace: 72, shooting: 71, passing: 79, dribbling: 81, defending: 50, physical: 50, height: 169, weight: 56, foot: "R", weakFoot: 3, potential: 80 },
    { nameEn: "Marco Reus", squadNumber: 18, nameKo: "마르코 로이스", birthdate: "1989-05-31", wikidataId: "Q152377", position: "CAM", positionGroup: "MF", pace: 53, shooting: 81, passing: 81, dribbling: 79, defending: 52, physical: 61, height: 180, weight: 71, foot: "R", weakFoot: 4, potential: 81, weeklyWage: 130000 },
    { nameEn: "Sergi Roberto", nameKo: "세르지 로베르토", birthdate: "1992-02-07", wikidataId: "Q703269", position: "CDM", positionGroup: "MF", pace: 69, shooting: 63, passing: 78, dribbling: 75, defending: 74, physical: 65, height: 178, weight: 68, foot: "R", weakFoot: 3, potential: 80 },
    { nameEn: "Joseph Paintsil", squadNumber: 28, nameKo: "조지프 페인칠", birthdate: "1998-02-01", wikidataId: "Q38367203", position: "LM", positionGroup: "MF", pace: 91, shooting: 70, passing: 66, dribbling: 78, defending: 35, physical: 66, height: 169, weight: 70, foot: "R", weakFoot: 3, potential: 78 },
    { nameEn: "Hirving Lozano", squadNumber: 11, nameKo: "이르빙 로사노", birthdate: "1995-07-30", wikidataId: "Q17633812", position: "LW", positionGroup: "FW", pace: 83, shooting: 75, passing: 71, dribbling: 79, defending: 41, physical: 58, height: 176, weight: 70, foot: "R", weakFoot: 3, potential: 78 },
    { nameEn: "Kyōgo Furuhashi", squadNumber: 7, nameKo: "후루하시 교고", birthdate: "1995-01-20", wikidataId: "Q28690600", position: "ST", positionGroup: "FW", pace: 83, shooting: 71, passing: 66, dribbling: 73, defending: 48, physical: 64, height: 170, weight: 63, foot: "R", weakFoot: 5, potential: 73 },
  ],
  torontofc: [
    { nameEn: "Walker Zimmerman", squadNumber: 25, nameKo: "워커 지머먼", birthdate: "1993-05-19", wikidataId: "Q13569294", position: "CB", positionGroup: "DF", pace: 56, shooting: 50, passing: 54, dribbling: 55, defending: 70, physical: 82, height: 190, weight: 89, foot: "R", weakFoot: 3, potential: 78 },
    { nameEn: "Matheus Pereira", squadNumber: 3, nameKo: "마테우스 페레이라", birthdate: "2000-12-21", wikidataId: "Q62399029", position: "LB", positionGroup: "DF", pace: 77, shooting: 57, passing: 61, dribbling: 68, defending: 65, physical: 71, height: 172, weight: 68, foot: "L", weakFoot: 3, potential: 73 },
    { nameEn: "Djordje Mihailovic", squadNumber: 10, nameKo: "조르제 미하일로비치", birthdate: "1998-11-10", wikidataId: "Q28800388", position: "CAM", positionGroup: "MF", pace: 71, shooting: 72, passing: 75, dribbling: 74, defending: 60, physical: 67, height: 178, weight: 69, foot: "R", weakFoot: 4, potential: 77 },
    { nameEn: "Niklas Dorsch", squadNumber: 6, nameKo: "니클라스 도르슈", birthdate: "1998-01-15", wikidataId: "Q24449743", position: "CDM", positionGroup: "MF", pace: 70, shooting: 71, passing: 72, dribbling: 77, defending: 71, physical: 70, height: 178, weight: 76, foot: "R", weakFoot: 3, potential: 77 },
    { nameEn: "Jonathan Osorio", squadNumber: 21, nameKo: "조너선 오소리오", birthdate: "1992-06-12", wikidataId: "Q10554558", position: "CM", positionGroup: "MF", pace: 50, shooting: 67, passing: 70, dribbling: 72, defending: 61, physical: 65, height: 175, weight: 68, foot: "R", weakFoot: 5, potential: 72 },
    { nameEn: "Josh Sargent", squadNumber: 9, nameKo: "조시 사전트", birthdate: "2000-02-20", wikidataId: "Q30032829", position: "ST", positionGroup: "FW", pace: 74, shooting: 74, passing: 62, dribbling: 69, defending: 48, physical: 81, height: 185, weight: 79, foot: "R", weakFoot: 4, potential: 77 },
  ],
};

export const MARKET_LEAGUE_SQUADS: Record<string, readonly RealPlayerSeed[]> = {
  ...SAUDI_SQUADS,
  ...MLS_SQUADS,
};
