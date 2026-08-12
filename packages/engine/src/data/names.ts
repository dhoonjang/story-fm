/**
 * 합성 선수 이름 풀 — 절차 생성용. 실존 인물과의 일치는 우연이다.
 *
 * 한글과 로마자를 **짝으로** 갖는다. 화면은 한글을 읽고, id와 파생 해시는
 * 로마자를 읽는다 — 한글만 있으면 슬러그가 통째로 비어 이름 없는 id가 된다.
 */
export interface SyntheticName {
  ko: string;
  en: string;
}

export const FIRST_NAMES: readonly SyntheticName[] = [
  { ko: "제이든", en: "Jayden" },
  { ko: "루카", en: "Luca" },
  { ko: "마테오", en: "Mateo" },
  { ko: "칼럼", en: "Callum" },
  { ko: "이든", en: "Eden" },
  { ko: "노아", en: "Noah" },
  { ko: "핀리", en: "Finley" },
  { ko: "루벤", en: "Ruben" },
  { ko: "테오", en: "Teo" },
  { ko: "카이", en: "Kai" },
  { ko: "다니", en: "Dani" },
  { ko: "브루노", en: "Bruno" },
  { ko: "이반", en: "Ivan" },
  { ko: "율리안", en: "Julian" },
  { ko: "니코", en: "Nico" },
  { ko: "안드레", en: "Andre" },
  { ko: "요엘", en: "Joel" },
  { ko: "사무", en: "Samu" },
  { ko: "라민", en: "Lamine" },
  { ko: "오스카", en: "Oscar" },
  { ko: "해리", en: "Harry" },
  { ko: "조지", en: "George" },
  { ko: "루이스", en: "Louis" },
  { ko: "아치", en: "Archie" },
  { ko: "프레디", en: "Freddie" },
  { ko: "톰", en: "Tom" },
  { ko: "잭", en: "Jack" },
  { ko: "올리", en: "Ollie" },
  { ko: "찰리", en: "Charlie" },
  { ko: "리오", en: "Rio" },
];

export const LAST_NAMES: readonly SyntheticName[] = [
  { ko: "월콧", en: "Walcott" },
  { ko: "베넷", en: "Bennett" },
  { ko: "카터", en: "Carter" },
  { ko: "돌턴", en: "Dalton" },
  { ko: "엘리스", en: "Ellis" },
  { ko: "포스터", en: "Foster" },
  { ko: "그레이", en: "Gray" },
  { ko: "홀랜드", en: "Holland" },
  { ko: "잉그램", en: "Ingram" },
  { ko: "젠킨스", en: "Jenkins" },
  { ko: "켈러", en: "Keller" },
  { ko: "로페스", en: "Lopez" },
  { ko: "모건", en: "Morgan" },
  { ko: "누네스", en: "Nunes" },
  { ko: "오코너", en: "O'Connor" },
  { ko: "페레이라", en: "Pereira" },
  { ko: "퀸", en: "Quinn" },
  { ko: "라모스", en: "Ramos" },
  { ko: "실바", en: "Silva" },
  { ko: "터너", en: "Turner" },
  { ko: "우드", en: "Wood" },
  { ko: "바르가스", en: "Vargas" },
  { ko: "윌리스", en: "Willis" },
  { ko: "자일스", en: "Giles" },
  { ko: "영블러드", en: "Youngblood" },
  { ko: "브랜트", en: "Brandt" },
  { ko: "코스타", en: "Costa" },
  { ko: "듀크", en: "Duke" },
  { ko: "에반스", en: "Evans" },
  { ko: "플린", en: "Flynn" },
];
