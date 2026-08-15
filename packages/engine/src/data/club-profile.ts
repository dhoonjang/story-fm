/**
 * 구단 재정 프로필 — 구장 규모와 브랜드 규모. 팀 카탈로그처럼 **불변 초기치**이고
 * 게임 세이브에는 들어가지 않는다.
 *
 * 팀 카탈로그(team-catalog.ts)와 파일을 나눈 이유: 정체성(이름·리그·전력 등급)과
 * 살림(구장·브랜드)은 바뀌는 이유가 다르다. 재정 밸런싱은 이 표 하나만 만진다.
 *
 * - `capacity` — 실제 구장 수용인원의 **어림값**. 매치데이 수입의 기준이고, 팀 간
 *   6배 격차(올드 트래퍼드 74k ↔ 비타리티 11k)가 그대로 재정 격차가 된다.
 *   라이선스 부채는 실선수 데이터와 같은 성격이다 (data-sourcing §7).
 * - `commercialTier` — **브랜드 규모 1~4. 전력 `tier`와 별개 축이다.** 뉴캐슬·
 *   샬케·에버튼은 성적보다 브랜드가 크고, 본머스·코모는 반대다. 실제 상업 수입
 *   격차의 원인이므로 tier로 뭉개면 클럽이 구분되지 않는다.
 *
 * 등재되지 않은 팀(어드민 추가 등)은 tier 기준 폴백을 쓴다.
 *
 * 아래 표는 **시드**다 — 어드민 편집본은 팀 오버라이드 파일에 함께 실린다
 * (`data/team-override.ts`). 지금 값은 `clubProfiles()`가 답한다.
 */
import { catalogSource } from "./catalog-source";
import { readTeamOverride } from "./team-override";

export interface ClubProfile {
  stadium: string;
  capacity: number;
  commercialTier: 1 | 2 | 3 | 4;
}

export const CLUB_PROFILES_SEED: Record<string, ClubProfile> = {
  // ── 프리미어리그 ──
  arsenal: { stadium: "에미레이츠 스타디움", capacity: 60_704, commercialTier: 1 },
  mancity: { stadium: "에티하드 스타디움", capacity: 61_000, commercialTier: 1 },
  manutd: { stadium: "올드 트래퍼드", capacity: 74_310, commercialTier: 1 },
  liverpool: { stadium: "안필드", capacity: 61_276, commercialTier: 1 },
  chelsea: { stadium: "스탬퍼드 브리지", capacity: 40_343, commercialTier: 1 },
  tottenham: { stadium: "토트넘 홋스퍼 스타디움", capacity: 62_850, commercialTier: 1 },
  newcastle: { stadium: "세인트 제임스 파크", capacity: 52_305, commercialTier: 2 },
  astonvilla: { stadium: "빌라 파크", capacity: 43_205, commercialTier: 2 },
  everton: { stadium: "힐 디킨슨 스타디움", capacity: 52_888, commercialTier: 2 },
  leeds: { stadium: "엘런드 로드", capacity: 37_645, commercialTier: 2 },
  sunderland: { stadium: "스타디움 오브 라이트", capacity: 48_095, commercialTier: 3 },
  brighton: { stadium: "아멕스 스타디움", capacity: 31_800, commercialTier: 3 },
  fulham: { stadium: "크레이븐 코티지", capacity: 28_107, commercialTier: 3 },
  crystalpalace: { stadium: "셀허스트 파크", capacity: 25_486, commercialTier: 3 },
  nottingham: { stadium: "시티 그라운드", capacity: 31_212, commercialTier: 3 },
  brentford: { stadium: "지테크 커뮤니티 스타디움", capacity: 17_250, commercialTier: 4 },
  bournemouth: { stadium: "바이탈리티 스타디움", capacity: 12_357, commercialTier: 4 },
  coventry: { stadium: "코번트리 빌딩 소사이어티 아레나", capacity: 32_609, commercialTier: 4 },
  ipswich: { stadium: "포트먼 로드", capacity: 30_311, commercialTier: 4 },
  hull: { stadium: "MKM 스타디움", capacity: 24_983, commercialTier: 4 },

  // ── 라리가 ──
  barcelona: { stadium: "캄 노우", capacity: 105_000, commercialTier: 1 },
  realmadrid: { stadium: "산티아고 베르나베우", capacity: 83_186, commercialTier: 1 },
  atletico: { stadium: "메트로폴리타노", capacity: 70_460, commercialTier: 1 },
  // 비야마린 재건축으로 2025-26·2026-27 두 시즌은 라 카르투하를 홈으로 쓴다
  betis: { stadium: "라 카르투하", capacity: 70_000, commercialTier: 2 },
  athletic: { stadium: "산 마메스", capacity: 53_289, commercialTier: 2 },
  sevilla: { stadium: "라몬 산체스 피스후안", capacity: 42_714, commercialTier: 2 },
  valencia: { stadium: "메스타야", capacity: 49_430, commercialTier: 2 },
  realsociedad: { stadium: "레알레 아레나", capacity: 40_000, commercialTier: 3 },
  villarreal: { stadium: "에스타디오 데 라 세라미카", capacity: 23_500, commercialTier: 3 },
  celta: { stadium: "발라이도스", capacity: 24_870, commercialTier: 3 },
  espanyol: { stadium: "RCDE 스타디움", capacity: 40_000, commercialTier: 3 },
  deportivo: { stadium: "리아소르", capacity: 32_660, commercialTier: 3 },
  malaga: { stadium: "라 로살레다", capacity: 30_044, commercialTier: 3 },
  osasuna: { stadium: "엘 사다르", capacity: 23_576, commercialTier: 3 },
  racing: { stadium: "엘 사르디네로", capacity: 22_222, commercialTier: 4 },
  getafe: { stadium: "콜리세움", capacity: 16_500, commercialTier: 4 },
  rayo: { stadium: "캄포 데 바예카스", capacity: 12_194, commercialTier: 4 },
  alaves: { stadium: "멘디소로차", capacity: 19_840, commercialTier: 4 },
  elche: { stadium: "마르티네스 발레로", capacity: 33_732, commercialTier: 4 },
  levante: { stadium: "시우다트 데 발렌시아", capacity: 26_354, commercialTier: 4 },

  // ── 세리에 A ──
  inter: { stadium: "산 시로", capacity: 75_817, commercialTier: 1 },
  milan: { stadium: "산 시로", capacity: 75_817, commercialTier: 1 },
  juventus: { stadium: "알리안츠 스타디움", capacity: 41_507, commercialTier: 1 },
  napoli: { stadium: "디에고 아르만도 마라도나", capacity: 54_726, commercialTier: 2 },
  roma: { stadium: "스타디오 올림피코", capacity: 70_634, commercialTier: 2 },
  lazio: { stadium: "스타디오 올림피코", capacity: 70_634, commercialTier: 2 },
  atalanta: { stadium: "게비스 스타디움", capacity: 23_439, commercialTier: 3 },
  fiorentina: { stadium: "아르테미오 프란키", capacity: 43_147, commercialTier: 3 },
  bologna: { stadium: "렌아토 달라라", capacity: 36_462, commercialTier: 3 },
  torino: { stadium: "올림피코 그란데 토리노", capacity: 27_958, commercialTier: 3 },
  genoa: { stadium: "루이지 페라리스", capacity: 33_205, commercialTier: 3 },
  udinese: { stadium: "블루에네르지아 스타디움", capacity: 25_144, commercialTier: 4 },
  sassuolo: { stadium: "마페이 스타디움", capacity: 21_584, commercialTier: 4 },
  cagliari: { stadium: "우니폴 도무스", capacity: 16_416, commercialTier: 4 },
  parma: { stadium: "엔니오 타르디니", capacity: 27_906, commercialTier: 4 },
  lecce: { stadium: "비아 델 마레", capacity: 31_533, commercialTier: 4 },
  como: { stadium: "주세페 시니갈리아", capacity: 13_602, commercialTier: 4 },
  venezia: { stadium: "피에르루이지 펜초", capacity: 12_048, commercialTier: 4 },
  frosinone: { stadium: "베니토 스티르페", capacity: 16_227, commercialTier: 4 },
  monza: { stadium: "U-파워 스타디움", capacity: 17_102, commercialTier: 4 },

  // ── 분데스리가 ──
  bayern: { stadium: "알리안츠 아레나", capacity: 75_024, commercialTier: 1 },
  dortmund: { stadium: "지그날 이두나 파크", capacity: 81_365, commercialTier: 1 },
  leipzig: { stadium: "레드불 아레나", capacity: 47_800, commercialTier: 2 },
  leverkusen: { stadium: "바이아레나", capacity: 30_210, commercialTier: 2 },
  frankfurt: { stadium: "도이체 방크 파르크", capacity: 59_500, commercialTier: 2 },
  schalke: { stadium: "펠틴스-아레나", capacity: 62_271, commercialTier: 2 },
  hamburg: { stadium: "폴크스파르크슈타디온", capacity: 57_000, commercialTier: 2 },
  stuttgart: { stadium: "MHP 아레나", capacity: 60_449, commercialTier: 3 },
  gladbach: { stadium: "보루시아-파르크", capacity: 54_042, commercialTier: 3 },
  werder: { stadium: "베저슈타디온", capacity: 42_100, commercialTier: 3 },
  koln: { stadium: "라인에네르기슈타디온", capacity: 50_000, commercialTier: 3 },
  freiburg: { stadium: "오이로파-파르크 슈타디온", capacity: 34_700, commercialTier: 3 },
  hoffenheim: { stadium: "프리제로 아레나", capacity: 30_150, commercialTier: 4 },
  mainz: { stadium: "메바 아레나", capacity: 33_305, commercialTier: 4 },
  augsburg: { stadium: "WWK 아레나", capacity: 30_660, commercialTier: 4 },
  unionberlin: { stadium: "알테 푀르스터라이", capacity: 22_012, commercialTier: 4 },
  elversberg: { stadium: "우르잘바흐", capacity: 14_221, commercialTier: 4 },
  paderborn: { stadium: "홈 도이체 아레나", capacity: 15_000, commercialTier: 4 },

  // ── 리그 1 ──
  psg: { stadium: "파르크 데 프랭스", capacity: 47_929, commercialTier: 1 },
  marseille: { stadium: "스타드 벨로드롬", capacity: 67_394, commercialTier: 2 },
  lyon: { stadium: "그루파마 스타디움", capacity: 59_186, commercialTier: 2 },
  lille: { stadium: "스타드 피에르-모루아", capacity: 50_186, commercialTier: 3 },
  monaco: { stadium: "스타드 루이 II", capacity: 16_360, commercialTier: 3 },
  rennes: { stadium: "로아종 파크", capacity: 29_778, commercialTier: 3 },
  lens: { stadium: "볼라에르-델렐리스", capacity: 38_058, commercialTier: 3 },
  nice: { stadium: "알리안츠 리비에라", capacity: 36_178, commercialTier: 3 },
  strasbourg: { stadium: "스타드 드 라 메노", capacity: 32_300, commercialTier: 4 },
  toulouse: { stadium: "스타디움 드 툴루즈", capacity: 33_150, commercialTier: 4 },
  lorient: { stadium: "스타드 뒤 물랭", capacity: 18_110, commercialTier: 4 },
  parisfc: { stadium: "스타드 장-부앵", capacity: 20_000, commercialTier: 4 },
  brest: { stadium: "스타드 프랑시스-르 블레", capacity: 15_220, commercialTier: 4 },
  angers: { stadium: "스타드 레몽 코파", capacity: 18_752, commercialTier: 4 },
  lehavre: { stadium: "스타드 오세앙", capacity: 25_178, commercialTier: 4 },
  auxerre: { stadium: "스타드 아베-데샹", capacity: 18_541, commercialTier: 4 },
  troyes: { stadium: "스타드 드 로브", capacity: 20_400, commercialTier: 4 },
  lemans: { stadium: "MMA 아레나", capacity: 25_064, commercialTier: 4 },
};

/** tier 폴백 — 카탈로그에 없는 팀(어드민 추가 등) */
const TIER_FALLBACK: Record<1 | 2 | 3 | 4, ClubProfile> = {
  1: { stadium: "홈 구장", capacity: 55_000, commercialTier: 1 },
  2: { stadium: "홈 구장", capacity: 42_000, commercialTier: 2 },
  3: { stadium: "홈 구장", capacity: 30_000, commercialTier: 3 },
  4: { stadium: "홈 구장", capacity: 22_000, commercialTier: 4 },
};

const profiles = catalogSource<Record<string, ClubProfile>>(
  () => readTeamOverride()?.clubProfiles ?? CLUB_PROFILES_SEED,
);

/** 지금 유효한 구단 프로필 표 */
export function clubProfiles(): Record<string, ClubProfile> {
  return profiles();
}

export function clubProfile(teamId: string, tier: 1 | 2 | 3 | 4): ClubProfile {
  return profiles()[teamId] ?? TIER_FALLBACK[tier];
}
