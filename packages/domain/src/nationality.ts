/**
 * 국적 — 축구에서 국적은 나라가 아니라 **협회(association)** 다.
 *
 * 잉글랜드·스코틀랜드·웨일스·북아일랜드는 한 나라 안의 네 협회이고, 홈그로운도
 * 비EU 쿼터도 대표팀도 전부 협회 단위로 걸린다. ISO 3166-1은 그 넷을 담지 못하므로
 * (`GBR` 하나뿐이다) 코드는 **FIFA 3자 협회 코드**를 쓴다 — 대부분의 나라에서
 * ISO alpha-3와 같고, 갈리는 자리(`GER`·`NED`·`SUI`·`POR`·`DEN`·`CRO`…)에서
 * 축구 쪽을 따른다.
 *
 * 이 표가 **국적 어휘의 원본**이다. 시드를 채우는 스크립트(`scripts/fill-nationality.ts`)도
 * 카탈로그의 결정적 파생도 여기 있는 코드만 낸다.
 */

/** 한 협회 — 표기와 EU 등록 자격 */
export interface Association {
  /** 한국 축구 언론 통용 표기 */
  ko: string;
  /**
   * EU 등록 자격을 갖는가 — 라리가·세리에A의 비EU 쿼터가 읽는 축.
   * EU 27 + EEA(노르웨이·아이슬란드·리히텐슈타인) + 스위스(인적 이동 협정)까지가
   * 실제 리그 규정의 "comunitario" 대역이라 여기서도 한 묶음이다.
   */
  eu?: true;
}

/**
 * 협회 표 — **리그 카탈로그의 `country`와 같은 한글 표기를 쓴다.** 홈그로운 협회
 * (`homegrownCountry`)가 그 표기를 쓰므로, 두 축이 한 나라를 두 이름으로 부르면
 * "잉글랜드 홈그로운인 ENG 선수"를 코드가 같은 사람으로 알아보지 못한다.
 */
export const ASSOCIATIONS: Record<string, Association> = {
  // ── 유럽 · EU/EEA 대역 ──
  ENG: { ko: "잉글랜드" },
  SCO: { ko: "스코틀랜드" },
  WAL: { ko: "웨일스" },
  NIR: { ko: "북아일랜드" },
  IRL: { ko: "아일랜드", eu: true },
  FRA: { ko: "프랑스", eu: true },
  ESP: { ko: "스페인", eu: true },
  ITA: { ko: "이탈리아", eu: true },
  GER: { ko: "독일", eu: true },
  POR: { ko: "포르투갈", eu: true },
  NED: { ko: "네덜란드", eu: true },
  BEL: { ko: "벨기에", eu: true },
  AUT: { ko: "오스트리아", eu: true },
  SUI: { ko: "스위스", eu: true },
  DEN: { ko: "덴마크", eu: true },
  SWE: { ko: "스웨덴", eu: true },
  NOR: { ko: "노르웨이", eu: true },
  FIN: { ko: "핀란드", eu: true },
  ISL: { ko: "아이슬란드", eu: true },
  POL: { ko: "폴란드", eu: true },
  CZE: { ko: "체코", eu: true },
  SVK: { ko: "슬로바키아", eu: true },
  SVN: { ko: "슬로베니아", eu: true },
  HUN: { ko: "헝가리", eu: true },
  ROU: { ko: "루마니아", eu: true },
  BUL: { ko: "불가리아", eu: true },
  GRE: { ko: "그리스", eu: true },
  CRO: { ko: "크로아티아", eu: true },
  EST: { ko: "에스토니아", eu: true },
  LVA: { ko: "라트비아", eu: true },
  LTU: { ko: "리투아니아", eu: true },
  LUX: { ko: "룩셈부르크", eu: true },
  CYP: { ko: "키프로스", eu: true },
  MLT: { ko: "몰타", eu: true },
  LIE: { ko: "리히텐슈타인", eu: true },
  // ── 유럽 · EU 밖 ──
  SRB: { ko: "세르비아" },
  BIH: { ko: "보스니아 헤르체고비나" },
  MNE: { ko: "몬테네그로" },
  MKD: { ko: "북마케도니아" },
  ALB: { ko: "알바니아" },
  KVX: { ko: "코소보" },
  UKR: { ko: "우크라이나" },
  RUS: { ko: "러시아" },
  TUR: { ko: "튀르키예" },
  GEO: { ko: "조지아" },
  ARM: { ko: "아르메니아" },
  ISR: { ko: "이스라엘" },
  // ── 아메리카 ──
  BRA: { ko: "브라질" },
  ARG: { ko: "아르헨티나" },
  URU: { ko: "우루과이" },
  CHI: { ko: "칠레" },
  COL: { ko: "콜롬비아" },
  ECU: { ko: "에콰도르" },
  PER: { ko: "페루" },
  PAR: { ko: "파라과이" },
  VEN: { ko: "베네수엘라" },
  SUR: { ko: "수리남" },
  USA: { ko: "미국" },
  CAN: { ko: "캐나다" },
  MEX: { ko: "멕시코" },
  JAM: { ko: "자메이카" },
  HON: { ko: "온두라스" },
  DOM: { ko: "도미니카공화국" },
  HAI: { ko: "아이티" },
  CUB: { ko: "쿠바" },
  ARU: { ko: "아루바" },
  // ── 아프리카 ──
  MAR: { ko: "모로코" },
  ALG: { ko: "알제리" },
  TUN: { ko: "튀니지" },
  EGY: { ko: "이집트" },
  LBY: { ko: "리비아" },
  SEN: { ko: "세네갈" },
  MLI: { ko: "말리" },
  CIV: { ko: "코트디부아르" },
  GHA: { ko: "가나" },
  NGA: { ko: "나이지리아" },
  CMR: { ko: "카메룬" },
  COD: { ko: "콩고민주공화국" },
  CGO: { ko: "콩고공화국" },
  GAB: { ko: "가봉" },
  GUI: { ko: "기니" },
  GNB: { ko: "기니비사우" },
  GAM: { ko: "감비아" },
  CPV: { ko: "카보베르데" },
  LBR: { ko: "라이베리아" },
  TOG: { ko: "토고" },
  BEN: { ko: "베냉" },
  BFA: { ko: "부르키나파소" },
  NIG: { ko: "니제르" },
  CHA: { ko: "차드" },
  CTA: { ko: "중앙아프리카공화국" },
  MTN: { ko: "모리타니" },
  ANG: { ko: "앙골라" },
  MOZ: { ko: "모잠비크" },
  ZAM: { ko: "잠비아" },
  ZIM: { ko: "짐바브웨" },
  TAN: { ko: "탄자니아" },
  KEN: { ko: "케냐" },
  BDI: { ko: "부룬디" },
  COM: { ko: "코모로" },
  ERI: { ko: "에리트레아" },
  SOM: { ko: "소말리아" },
  EQG: { ko: "적도기니" },
  // ── 아시아 · 오세아니아 ──
  JPN: { ko: "일본" },
  KOR: { ko: "대한민국" },
  CHN: { ko: "중국" },
  AUS: { ko: "호주" },
  NZL: { ko: "뉴질랜드" },
  IDN: { ko: "인도네시아" },
  MAS: { ko: "말레이시아" },
  THA: { ko: "태국" },
  UZB: { ko: "우즈베키스탄" },
  BAN: { ko: "방글라데시" },
  IRQ: { ko: "이라크" },
  JOR: { ko: "요르단" },
  KSA: { ko: "사우디아라비아" },
  KUW: { ko: "쿠웨이트" },
  SYR: { ko: "시리아" },
};

/** EU 등록 자격을 갖는 협회 — 표에서 파생한다 (같은 사실을 두 곳에 적지 않는다) */
export const EU_ASSOCIATIONS: ReadonlySet<string> = new Set(
  Object.entries(ASSOCIATIONS)
    .filter(([, a]) => a.eu === true)
    .map(([code]) => code),
);

/** 아는 협회 코드인가 */
export function isAssociation(code: string): boolean {
  return Object.hasOwn(ASSOCIATIONS, code);
}

/**
 * 이 선수가 EU 등록 자격을 갖는가 — **두 칸을 함께 본다.**
 * 둘째 국적이 하는 일이 정확히 이것이라, 첫째만 보면 EU 여권을 든 남미 선수가
 * 비EU 쿼터를 차지한다.
 */
export function isEuNational(player: {
  nationality?: string;
  secondNationality?: string;
}): boolean {
  return (
    (player.nationality !== undefined && EU_ASSOCIATIONS.has(player.nationality)) ||
    (player.secondNationality !== undefined && EU_ASSOCIATIONS.has(player.secondNationality))
  );
}

/** 협회 표기 — 모르는 코드는 코드 그대로 (없는 것을 지어내지 않는다) */
export function associationName(code: string): string {
  return ASSOCIATIONS[code]?.ko ?? code;
}

/** 한글 나라 이름 → 협회 코드 (리그 카탈로그의 `country`가 이 표기다) */
const CODE_BY_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(ASSOCIATIONS).map(([code, a]) => [a.ko, code]),
);

/**
 * 리그·구단의 나라에서 협회 코드로 — 조사가 닿지 않은 선수의 국적을 그 클럽
 * 협회로 세우는 결정적 파생이 이 함수를 지난다 (`world/catalog.ts`).
 */
export function associationOfCountry(country: string | null | undefined): string | undefined {
  return country == null ? undefined : CODE_BY_NAME.get(country);
}
