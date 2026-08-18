/**
 * 지어낸 사람 이름 풀 — 절차 생성 선수와 가상 인물(수석코치·구단주·기자·감독)이
 * 여기서 이름을 얻는다. 실존 인물과의 일치는 우연이다.
 *
 * 세 가지가 이 파일의 모양을 정한다.
 *
 * ① **나라별로 나눈다.** 영어권 이름 하나로 다 채우면 세군다 클럽 명단이 통째로
 *    잉글랜드 사람이 된다. 리그 국적을 따라가면 실명이 아니어도 그 리그의
 *    선수처럼 읽힌다. 한국어 중계 문맥의 표기를 따른다.
 * ② **한글과 로마자를 짝으로 갖는다.** 화면은 한글을 읽고, id와 파생 해시는
 *    로마자를 읽는다 — 한글만 있으면 슬러그가 통째로 비어 이름 없는 id가 된다.
 *    인물 풀은 화면에만 서므로 한글만 갖는다.
 * ③ **선수 풀과 인물 풀은 성이 겹치지 않는다.** 수석코치와 우리 선수가
 *    동명이인이면 `speakerRoles`가 둘 다 포기해 직책·아이콘이 함께 사라진다
 *    (people.md §1 — 태그는 전역 유일). 성을 나눠 두면 조합이 겹칠 수 없다.
 */
export interface SyntheticName {
  ko: string;
  en: string;
}

/** 절차 생성 선수의 이름 풀 — 이름 × 성 조합에서 뽑는다 */
export interface SyntheticNamePool {
  first: readonly SyntheticName[];
  last: readonly SyntheticName[];
}

/** 가상 인물(수석코치·구단주·기자·감독)의 이름 풀 — 화면 표기뿐이라 한글만 */
export interface PersonaNamePool {
  given: readonly string[];
  family: readonly string[];
}

/** 풀이 없는 나라가 떨어지는 자리 — 리그 국적을 모르는 팀도 이름은 있어야 한다 */
export const FALLBACK_NAME_COUNTRY = "잉글랜드";

const PLAYER_NAME_POOLS: Record<string, SyntheticNamePool> = {
  잉글랜드: {
    first: [
      { ko: "제이든", en: "Jayden" },
      { ko: "칼럼", en: "Callum" },
      { ko: "핀리", en: "Finley" },
      { ko: "아치", en: "Archie" },
      { ko: "프레디", en: "Freddie" },
      { ko: "올리", en: "Ollie" },
      { ko: "찰리", en: "Charlie" },
      { ko: "알피", en: "Alfie" },
      { ko: "스탠리", en: "Stanley" },
      { ko: "렉스", en: "Rex" },
      { ko: "로넌", en: "Ronan" },
      { ko: "마일스", en: "Miles" },
      { ko: "트리스탄", en: "Tristan" },
      { ko: "바너비", en: "Barnaby" },
      { ko: "허비", en: "Herbie" },
      { ko: "몬티", en: "Monty" },
      { ko: "네드", en: "Ned" },
      { ko: "아서", en: "Arthur" },
      { ko: "앨버트", en: "Albert" },
      { ko: "시드니", en: "Sidney" },
      { ko: "퍼시", en: "Percy" },
      { ko: "그레이엄", en: "Graham" },
      { ko: "데스먼드", en: "Desmond" },
      { ko: "로리", en: "Rory" },
      { ko: "키어런", en: "Kieran" },
      { ko: "배리", en: "Barry" },
      { ko: "니얼", en: "Niall" },
      { ko: "브렌던", en: "Brendan" },
      { ko: "던컨", en: "Duncan" },
      { ko: "프레이저", en: "Fraser" },
      { ko: "앵거스", en: "Angus" },
      { ko: "리스", en: "Rhys" },
      { ko: "개러스", en: "Gareth" },
      { ko: "토비", en: "Toby" },
      { ko: "새미", en: "Sammy" },
      { ko: "윌프", en: "Wilf" },
    ],
    last: [
      { ko: "애슈워스", en: "Ashworth" },
      { ko: "브래드쇼", en: "Bradshaw" },
      { ko: "캐링턴", en: "Carrington" },
      { ko: "돌턴", en: "Dalton" },
      { ko: "엘러비", en: "Ellerby" },
      { ko: "페어허스트", en: "Fairhurst" },
      { ko: "갤브레이스", en: "Galbraith" },
      { ko: "해서웨이", en: "Hathaway" },
      { ko: "잉글비", en: "Ingleby" },
      { ko: "젠킨스", en: "Jenkins" },
      { ko: "킬브라이드", en: "Kilbride" },
      { ko: "랭턴", en: "Langton" },
      { ko: "머서", en: "Mercer" },
      { ko: "노스콧", en: "Northcott" },
      { ko: "오크스", en: "Oakes" },
      { ko: "페닝턴", en: "Pennington" },
      { ko: "퀸턴", en: "Quinton" },
      { ko: "래드클리프", en: "Radcliffe" },
      { ko: "스토크스", en: "Stokes" },
      { ko: "서스턴", en: "Thurston" },
      { ko: "언더힐", en: "Underhill" },
      { ko: "밴스", en: "Vance" },
      { ko: "위트모어", en: "Whitmore" },
      { ko: "예이츠", en: "Yates" },
      { ko: "애컬리", en: "Ackerley" },
      { ko: "블레이크모어", en: "Blakemore" },
      { ko: "콜브룩", en: "Colbrook" },
      { ko: "더크워스", en: "Duckworth" },
      { ko: "엘름허스트", en: "Elmhurst" },
      { ko: "풀처", en: "Fulcher" },
      { ko: "그린할", en: "Greenhalgh" },
      { ko: "하틀리", en: "Hartley" },
      { ko: "아이언사이드", en: "Ironside" },
      { ko: "켄들", en: "Kendall" },
      { ko: "리틀우드", en: "Littlewood" },
      { ko: "로손", en: "Rawson" },
    ],
  },
  스페인: {
    first: [
      { ko: "이케르", en: "Iker" },
      { ko: "아이토르", en: "Aitor" },
      { ko: "보르하", en: "Borja" },
      { ko: "세사르", en: "Cesar" },
      { ko: "엔리케", en: "Enrique" },
      { ko: "곤살로", en: "Gonzalo" },
      { ko: "호세바", en: "Joseba" },
      { ko: "키케", en: "Kike" },
      { ko: "로렌소", en: "Lorenzo" },
      { ko: "마놀로", en: "Manolo" },
      { ko: "나초", en: "Nacho" },
      { ko: "파코", en: "Paco" },
      { ko: "사울", en: "Saul" },
      { ko: "텔모", en: "Telmo" },
      { ko: "우나이", en: "Unai" },
      { ko: "빅토르", en: "Victor" },
      { ko: "사비", en: "Xabi" },
      { ko: "욘", en: "Jon" },
      { ko: "아드리안", en: "Adrian" },
      { ko: "베니토", en: "Benito" },
      { ko: "에드가르", en: "Edgar" },
      { ko: "프란", en: "Fran" },
      { ko: "기예르모", en: "Guillermo" },
      { ko: "이그나시오", en: "Ignacio" },
      { ko: "하이메", en: "Jaime" },
      { ko: "후아니토", en: "Juanito" },
      { ko: "마르코스", en: "Marcos" },
      { ko: "니콜라스", en: "Nicolas" },
      { ko: "로드리고", en: "Rodrigo" },
      { ko: "토니", en: "Toni" },
      { ko: "우발도", en: "Ubaldo" },
      { ko: "하비", en: "Javi" },
      { ko: "루벤", en: "Ruben" },
      { ko: "이시드로", en: "Isidro" },
      { ko: "안드레스", en: "Andres" },
      { ko: "펠릭스", en: "Felix" },
    ],
    last: [
      { ko: "아리아스", en: "Arias" },
      { ko: "벨트란", en: "Beltran" },
      { ko: "카날레스", en: "Canales" },
      { ko: "도라도", en: "Dorado" },
      { ko: "에스쿠데로", en: "Escudero" },
      { ko: "파리냐스", en: "Farinas" },
      { ko: "갈베스", en: "Galvez" },
      { ko: "에레라", en: "Herrera" },
      { ko: "이바녜스", en: "Ibanez" },
      { ko: "히메노", en: "Jimeno" },
      { ko: "라라", en: "Lara" },
      { ko: "몬토야", en: "Montoya" },
      { ko: "노게라", en: "Noguera" },
      { ko: "오르티스", en: "Ortiz" },
      { ko: "파스토르", en: "Pastor" },
      { ko: "케베도", en: "Quevedo" },
      { ko: "리베라", en: "Rivera" },
      { ko: "세고비아", en: "Segovia" },
      { ko: "토바르", en: "Tovar" },
      { ko: "우리베", en: "Uribe" },
      { ko: "발데스", en: "Valdes" },
      { ko: "사모라", en: "Zamora" },
      { ko: "아세베도", en: "Acevedo" },
      { ko: "바레라", en: "Barrera" },
      { ko: "카바예로", en: "Caballero" },
      { ko: "델가도", en: "Delgado" },
      { ko: "에스테베스", en: "Estevez" },
      { ko: "푸엔테스", en: "Fuentes" },
      { ko: "가야르도", en: "Gallardo" },
      { ko: "이달고", en: "Hidalgo" },
      { ko: "이리아르테", en: "Iriarte" },
      { ko: "하우레기", en: "Jauregui" },
      { ko: "레케나", en: "Requena" },
      { ko: "니에토", en: "Nieto" },
      { ko: "오헤다", en: "Ojeda" },
      { ko: "우르타도", en: "Hurtado" },
    ],
  },
  이탈리아: {
    first: [
      { ko: "알레시오", en: "Alessio" },
      { ko: "니콜로", en: "Niccolo" },
      { ko: "리카르도", en: "Riccardo" },
      { ko: "툴리오", en: "Tullio" },
      { ko: "에마누엘레", en: "Emanuele" },
      { ko: "잔루카", en: "Gianluca" },
      { ko: "파우스토", en: "Fausto" },
      { ko: "로렌초", en: "Lorenzo" },
      { ko: "마시모", en: "Massimo" },
      { ko: "오라치오", en: "Orazio" },
      { ko: "피에트로", en: "Pietro" },
      { ko: "라파엘레", en: "Raffaele" },
      { ko: "시모네", en: "Simone" },
      { ko: "티치아노", en: "Tiziano" },
      { ko: "움베르토", en: "Umberto" },
      { ko: "발렌티노", en: "Valentino" },
      { ko: "아메데오", en: "Amedeo" },
      { ko: "첼레스티노", en: "Celestino" },
      { ko: "도메니코", en: "Domenico" },
      { ko: "엔리코", en: "Enrico" },
      { ko: "페루초", en: "Ferruccio" },
      { ko: "굴리엘모", en: "Guglielmo" },
      { ko: "이냐치오", en: "Ignazio" },
      { ko: "마우리치오", en: "Maurizio" },
      { ko: "나탈레", en: "Natale" },
      { ko: "오타비오", en: "Ottavio" },
      { ko: "파스콸레", en: "Pasquale" },
      { ko: "로몰로", en: "Romolo" },
      { ko: "세베리노", en: "Severino" },
      { ko: "토마소", en: "Tommaso" },
      { ko: "비토리오", en: "Vittorio" },
      { ko: "아킬레", en: "Achille" },
      { ko: "코라도", en: "Corrado" },
      { ko: "에토레", en: "Ettore" },
      { ko: "플라비오", en: "Flavio" },
      { ko: "이보", en: "Ivo" },
    ],
    last: [
      { ko: "아모로소", en: "Amoroso" },
      { ko: "바르바로", en: "Barbaro" },
      { ko: "카펠리니", en: "Cappellini" },
      { ko: "다미아니", en: "Damiani" },
      { ko: "파브리스", en: "Fabris" },
      { ko: "그라나타", en: "Granata" },
      { ko: "인노첸티", en: "Innocenti" },
      { ko: "라차리니", en: "Lazzarini" },
      { ko: "마니에로", en: "Maniero" },
      { ko: "노벨리", en: "Novelli" },
      { ko: "오를란디", en: "Orlandi" },
      { ko: "페트루치", en: "Petrucci" },
      { ko: "콰란타", en: "Quaranta" },
      { ko: "로시니", en: "Rossini" },
      { ko: "사보이아", en: "Savoia" },
      { ko: "토스카노", en: "Toscano" },
      { ko: "우발디니", en: "Ubaldini" },
      { ko: "벤투리니", en: "Venturini" },
      { ko: "차니니", en: "Zanini" },
      { ko: "아고스티니", en: "Agostini" },
      { ko: "베르톨디", en: "Bertoldi" },
      { ko: "카타네오", en: "Cattaneo" },
      { ko: "도나티", en: "Donati" },
      { ko: "파비아니", en: "Fabiani" },
      { ko: "감바로", en: "Gambaro" },
      { ko: "이오리오", en: "Iorio" },
      { ko: "리차르디", en: "Licciardi" },
      { ko: "몬텔레오네", en: "Monteleone" },
      { ko: "나르디", en: "Nardi" },
      { ko: "오르시니", en: "Orsini" },
      { ko: "폴리도리", en: "Polidori" },
      { ko: "리촐리", en: "Rizzoli" },
      { ko: "스카르파", en: "Scarpa" },
      { ko: "트레비산", en: "Trevisan" },
      { ko: "발렌티니", en: "Valentini" },
      { ko: "차카리아", en: "Zaccaria" },
    ],
  },
  독일: {
    first: [
      { ko: "렌나르트", en: "Lennart" },
      { ko: "요나스", en: "Jonas" },
      { ko: "티모", en: "Timo" },
      { ko: "마르빈", en: "Marvin" },
      { ko: "파비안", en: "Fabian" },
      { ko: "스벤", en: "Sven" },
      { ko: "필리프", en: "Philipp" },
      { ko: "모리츠", en: "Moritz" },
      { ko: "라세", en: "Lasse" },
      { ko: "하네스", en: "Hannes" },
      { ko: "유스투스", en: "Justus" },
      { ko: "아르네", en: "Arne" },
      { ko: "베네딕트", en: "Benedikt" },
      { ko: "크리스토프", en: "Christoph" },
      { ko: "에밀", en: "Emil" },
      { ko: "프리츠", en: "Fritz" },
      { ko: "게로", en: "Gero" },
      { ko: "헨드리크", en: "Hendrik" },
      { ko: "잉고", en: "Ingo" },
      { ko: "요헨", en: "Jochen" },
      { ko: "클라스", en: "Claas" },
      { ko: "레온하르트", en: "Leonhard" },
      { ko: "말테", en: "Malte" },
      { ko: "니클라스", en: "Niklas" },
      { ko: "오스카어", en: "Oskar" },
      { ko: "파울", en: "Paul" },
      { ko: "라이너", en: "Rainer" },
      { ko: "슈테펜", en: "Steffen" },
      { ko: "토르벤", en: "Torben" },
      { ko: "폴커", en: "Volker" },
      { ko: "빌리", en: "Willi" },
      { ko: "요스트", en: "Jost" },
      { ko: "게오르크", en: "Georg" },
      { ko: "하이코", en: "Heiko" },
      { ko: "라르스", en: "Lars" },
      { ko: "마리우스", en: "Marius" },
    ],
    last: [
      { ko: "알트만", en: "Altmann" },
      { ko: "베렌스", en: "Behrens" },
      { ko: "크라머", en: "Cramer" },
      { ko: "데커", en: "Decker" },
      { ko: "에어하르트", en: "Erhardt" },
      { ko: "프라이타크", en: "Freitag" },
      { ko: "그로스만", en: "Grossmann" },
      { ko: "하이덴라이히", en: "Heidenreich" },
      { ko: "이믈러", en: "Immler" },
      { ko: "융한스", en: "Junghans" },
      { ko: "카이저", en: "Kaiser" },
      { ko: "로이트너", en: "Leutner" },
      { ko: "마이엔부르크", en: "Meienburg" },
      { ko: "노이바우어", en: "Neubauer" },
      { ko: "오스터만", en: "Ostermann" },
      { ko: "프렌첼", en: "Prenzel" },
      { ko: "라이헬트", en: "Reichelt" },
      { ko: "슈타인바흐", en: "Steinbach" },
      { ko: "틸레", en: "Thiele" },
      { ko: "울리히", en: "Ulrich" },
      { ko: "포겔장", en: "Vogelsang" },
      { ko: "베스트팔", en: "Westphal" },
      { ko: "첼러", en: "Zeller" },
      { ko: "아렌트", en: "Arendt" },
      { ko: "비어만", en: "Biermann" },
      { ko: "클라우센", en: "Claussen" },
      { ko: "딜만", en: "Dillmann" },
      { ko: "엥겔브레히트", en: "Engelbrecht" },
      { ko: "게르트너", en: "Gertner" },
      { ko: "하르트만", en: "Hartmann" },
      { ko: "이젠베크", en: "Isenbeck" },
      { ko: "린데만", en: "Lindemann" },
      { ko: "모저", en: "Moser" },
      { ko: "니마이어", en: "Niemeyer" },
      { ko: "오버마이어", en: "Obermeier" },
      { ko: "파울젠", en: "Paulsen" },
    ],
  },
  프랑스: {
    first: [
      { ko: "바티스트", en: "Baptiste" },
      { ko: "클레망", en: "Clement" },
      { ko: "디디에", en: "Didier" },
      { ko: "에르베", en: "Herve" },
      { ko: "파비앵", en: "Fabien" },
      { ko: "그레고리", en: "Gregory" },
      { ko: "조프루아", en: "Geoffroy" },
      { ko: "케뱅", en: "Kevin" },
      { ko: "뤼도빅", en: "Ludovic" },
      { ko: "마티아스", en: "Mathias" },
      { ko: "노에", en: "Noe" },
      { ko: "올리비에", en: "Olivier" },
      { ko: "파스칼", en: "Pascal" },
      { ko: "캉탱", en: "Quentin" },
      { ko: "레미", en: "Remy" },
      { ko: "실뱅", en: "Sylvain" },
      { ko: "티보", en: "Thibaut" },
      { ko: "위르뱅", en: "Urbain" },
      { ko: "발랑탱", en: "Valentin" },
      { ko: "야닉", en: "Yannick" },
      { ko: "아드리앵", en: "Adrien" },
      { ko: "코랑탱", en: "Corentin" },
      { ko: "다미앵", en: "Damien" },
      { ko: "에티엔", en: "Etienne" },
      { ko: "플로리앙", en: "Florian" },
      { ko: "가엘", en: "Gael" },
      { ko: "조나탕", en: "Jonathan" },
      { ko: "로익", en: "Loic" },
      { ko: "막심", en: "Maxime" },
      { ko: "나탕", en: "Nathan" },
      { ko: "옥타브", en: "Octave" },
      { ko: "필리프", en: "Philippe" },
      { ko: "로맹", en: "Romain" },
      { ko: "트리스탕", en: "Tristan" },
      { ko: "세드리크", en: "Cedric" },
      { ko: "아르노", en: "Arnaud" },
    ],
    last: [
      { ko: "아르셀랭", en: "Arcelin" },
      { ko: "부아시에", en: "Boissier" },
      { ko: "샤르팡티에", en: "Charpentier" },
      { ko: "들로네", en: "Delaunay" },
      { ko: "에스캉드", en: "Escande" },
      { ko: "푸르니에", en: "Fournier" },
      { ko: "가르니에", en: "Garnier" },
      { ko: "위블랭", en: "Hublin" },
      { ko: "이자르", en: "Izard" },
      { ko: "주베르", en: "Joubert" },
      { ko: "코르뉘", en: "Cornu" },
      { ko: "라베르뉴", en: "Lavergne" },
      { ko: "마르샹", en: "Marchand" },
      { ko: "노게", en: "Nogues" },
      { ko: "오디베르", en: "Audibert" },
      { ko: "페리에", en: "Perrier" },
      { ko: "케메네르", en: "Quemener" },
      { ko: "루소", en: "Rousseau" },
      { ko: "사바티에", en: "Sabatier" },
      { ko: "테시에", en: "Tessier" },
      { ko: "발레트", en: "Valette" },
      { ko: "뷔토", en: "Buteau" },
      { ko: "샤스탱", en: "Chastain" },
      { ko: "뒤크로", en: "Ducroz" },
      { ko: "프뤼니에", en: "Prunier" },
      { ko: "가야르", en: "Gaillard" },
      { ko: "오샤르", en: "Auchard" },
      { ko: "랑글루아", en: "Langlois" },
      { ko: "메나르", en: "Menard" },
      { ko: "노디에", en: "Nodier" },
      { ko: "오리올", en: "Oriol" },
      { ko: "파코", en: "Pacaud" },
      { ko: "르누아르", en: "Renoir" },
      { ko: "사부아", en: "Savoie" },
      { ko: "티리옹", en: "Thirion" },
      { ko: "베르디에", en: "Verdier" },
    ],
  },
  사우디아라비아: {
    first: [
      { ko: "압둘라", en: "Abdullah" },
      { ko: "파이살", en: "Faisal" },
      { ko: "칼리드", en: "Khalid" },
      { ko: "마제드", en: "Majed" },
      { ko: "나세르", en: "Nasser" },
      { ko: "오마르", en: "Omar" },
      { ko: "라예드", en: "Rayed" },
      { ko: "사미", en: "Sami" },
      { ko: "탈랄", en: "Talal" },
      { ko: "왈리드", en: "Waleed" },
      { ko: "야세르", en: "Yasser" },
      { ko: "자키", en: "Zaki" },
      { ko: "바데르", en: "Bader" },
      { ko: "하템", en: "Hatem" },
      { ko: "이브라힘", en: "Ibrahim" },
      { ko: "주바이르", en: "Jubair" },
      { ko: "카말", en: "Kamal" },
      { ko: "라이안", en: "Rayan" },
      { ko: "무한나드", en: "Muhannad" },
      { ko: "아이만", en: "Ayman" },
      { ko: "투르키", en: "Turki" },
      { ko: "술탄", en: "Sultan" },
      { ko: "지야드", en: "Ziyad" },
      { ko: "하니", en: "Hani" },
    ],
    last: [
      { ko: "알주하니", en: "Al-Juhani" },
      { ko: "알루바이에", en: "Al-Rubaie" },
      { ko: "알수바이에", en: "Al-Subaie" },
      { ko: "알마트라피", en: "Al-Matrafi" },
      { ko: "알가산", en: "Al-Ghassan" },
      { ko: "알바크르", en: "Al-Bakr" },
      { ko: "알타위", en: "Al-Tawi" },
      { ko: "알함마드", en: "Al-Hammad" },
      { ko: "알와일", en: "Al-Wail" },
      { ko: "알야미", en: "Al-Yami" },
      { ko: "알사히", en: "Al-Sahi" },
      { ko: "알루와일리", en: "Al-Ruwaili" },
      { ko: "알말키", en: "Al-Malki" },
      { ko: "알수하이미", en: "Al-Suhaimi" },
      { ko: "알바르가시", en: "Al-Barghash" },
      { ko: "알미슈알", en: "Al-Mishal" },
      { ko: "알나이프", en: "Al-Naif" },
      { ko: "알쿠라이시", en: "Al-Quraishi" },
      { ko: "알사파르", en: "Al-Saffar" },
      { ko: "알투와이지리", en: "Al-Tuwaijri" },
      { ko: "알우바이드", en: "Al-Ubaid" },
      { ko: "알자킬", en: "Al-Zakil" },
      { ko: "알하미단", en: "Al-Hamidan" },
      { ko: "알카티브", en: "Al-Khatib" },
    ],
  },
  미국: {
    first: [
      { ko: "브랜던", en: "Brandon" },
      { ko: "채드", en: "Chad" },
      { ko: "코디", en: "Cody" },
      { ko: "데번", en: "Devin" },
      { ko: "일라이", en: "Eli" },
      { ko: "개빈", en: "Gavin" },
      { ko: "헌터", en: "Hunter" },
      { ko: "재러드", en: "Jared" },
      { ko: "콜턴", en: "Colton" },
      { ko: "랜던", en: "Landon" },
      { ko: "메이슨", en: "Mason" },
      { ko: "네이선", en: "Nathan" },
      { ko: "오스틴", en: "Austin" },
      { ko: "페이턴", en: "Peyton" },
      { ko: "라일리", en: "Riley" },
      { ko: "셰인", en: "Shane" },
      { ko: "트래비스", en: "Travis" },
      { ko: "타일러", en: "Tyler" },
      { ko: "웨스턴", en: "Weston" },
      { ko: "재커리", en: "Zachary" },
      { ko: "브레이든", en: "Braden" },
      { ko: "케이든", en: "Kaden" },
      { ko: "로건", en: "Logan" },
      { ko: "그랜트", en: "Grant" },
    ],
    last: [
      { ko: "애벗", en: "Abbott" },
      { ko: "배런", en: "Barron" },
      { ko: "콜드웰", en: "Caldwell" },
      { ko: "도허티", en: "Doherty" },
      { ko: "에버렛", en: "Everett" },
      { ko: "포싯", en: "Fawcett" },
      { ko: "그리핀", en: "Griffin" },
      { ko: "홀로웨이", en: "Holloway" },
      { ko: "잉걸스", en: "Ingalls" },
      { ko: "키넌", en: "Keenan" },
      { ko: "랜드리", en: "Landry" },
      { ko: "매킨리", en: "McKinley" },
      { ko: "노턴", en: "Norton" },
      { ko: "오도널", en: "O'Donnell" },
      { ko: "파커", en: "Parker" },
      { ko: "퀸랜", en: "Quinlan" },
      { ko: "리브스", en: "Reeves" },
      { ko: "새먼스", en: "Sammons" },
      { ko: "톨리버", en: "Tolliver" },
      { ko: "밴더빌트", en: "Vanderbilt" },
      { ko: "휘터커", en: "Whitaker" },
      { ko: "요더", en: "Yoder" },
      { ko: "자이글러", en: "Zeigler" },
      { ko: "브레넌", en: "Brennan" },
    ],
  },
};

/**
 * 가상 인물의 이름 풀 — 성이 선수 풀과 겹치지 않는다(위 ③).
 * 풀이 없는 나라는 잉글랜드로 떨어지므로, 그 성들도 어느 선수 풀에도 없어야 한다.
 */
const PERSONA_NAME_POOLS: Record<string, PersonaNamePool> = {
  잉글랜드: {
    given: ["제임스", "토마스", "대니얼", "마이클", "올리버", "해리", "에런", "루크"],
    family: ["베넷", "콜린스", "하퍼", "그레이", "모건", "라이언", "웰스", "다우니"],
  },
  스페인: {
    given: ["파블로", "하비에르", "세르히오", "알바로", "이반", "미겔"],
    family: ["페레스", "리코", "아란다", "몰리나", "세라노", "나바로"],
  },
  이탈리아: {
    given: ["루카", "마르코", "안드레아", "다비데", "스테파노", "마테오"],
    family: ["마르케티", "리치", "베르가모", "콘티", "파리네티", "갈리"],
  },
  독일: {
    given: ["슈테판", "토비아스", "마티아스", "얀", "플로리안", "닐스"],
    family: ["브란트", "슈타이너", "케슬러", "바그너", "호프만", "슈나이더"],
  },
  프랑스: {
    given: ["니콜라", "티에리", "쥘리앵", "마티외", "로랑", "뱅상"],
    family: ["뒤퐁", "샤보네", "르콩트", "지라르", "베르나르", "포르티에"],
  },
};

/** 나라 → 절차 생성 선수 이름 풀. 풀이 없는 나라는 잉글랜드로 떨어진다 */
export function syntheticNamePoolOf(country: string | undefined): SyntheticNamePool {
  return (
    (country !== undefined ? PLAYER_NAME_POOLS[country] : undefined) ??
    PLAYER_NAME_POOLS[FALLBACK_NAME_COUNTRY]!
  );
}

/** 나라 → 가상 인물 이름 풀. 풀이 없는 나라는 잉글랜드로 떨어진다 */
export function personaNamePoolOf(country: string | undefined): PersonaNamePool {
  return (
    (country !== undefined ? PERSONA_NAME_POOLS[country] : undefined) ??
    PERSONA_NAME_POOLS[FALLBACK_NAME_COUNTRY]!
  );
}

/** 풀을 가진 나라 목록 — 테스트가 전수를 훑을 때 쓴다 */
export const SYNTHETIC_NAME_COUNTRIES = Object.keys(PLAYER_NAME_POOLS);
export const PERSONA_NAME_COUNTRIES = Object.keys(PERSONA_NAME_POOLS);

/**
 * 재추첨 상한 — 여기까지 겹치면 남은 조합을 결정적으로 훑는다.
 * 스쿼드 42명에 조합이 1,000개 넘으므로 한 번에 걸리는 것이 보통이다.
 */
const REDRAW_LIMIT = 8;

/** 뽑힌 자리 — `suffix`가 0이 아니면 조합이 동나 번호를 붙였다는 뜻이다 */
interface NameSlot {
  first: number;
  last: number;
  suffix: number;
}

/**
 * 두 목록의 조합에서 아직 안 쓰인 자리 하나 — 고르고 `taken`에 등록한다.
 *
 * ① 시드 rng로 재추첨 → ② 상한에 닿으면 남은 조합을 결정적으로 훑고 →
 * ③ 조합이 동나면 번호를 붙인다. 어느 갈래든 **같은 시드는 같은 이름**을 낸다.
 * 등록까지 여기서 하는 이유는 `claimPlayerId`와 같다: 유일성이 부르는 쪽의
 * 기억력에 걸리면 안 된다.
 */
function claimNameSlot(
  rng: () => number,
  counts: { first: number; last: number },
  label: (slot: NameSlot) => string,
  taken: Set<string>,
): NameSlot {
  const claim = (slot: NameSlot): NameSlot | null => {
    const key = label(slot);
    if (taken.has(key)) return null;
    taken.add(key);
    return slot;
  };
  let drawn: NameSlot = { first: 0, last: 0, suffix: 0 };
  for (let i = 0; i < REDRAW_LIMIT; i++) {
    drawn = {
      first: Math.floor(rng() * counts.first),
      last: Math.floor(rng() * counts.last),
      suffix: 0,
    };
    const got = claim(drawn);
    if (got) return got;
  }
  const total = counts.first * counts.last;
  const from = drawn.first + counts.first * drawn.last;
  for (let step = 1; step <= total; step++) {
    const at = (from + step) % total;
    const got = claim({ first: at % counts.first, last: Math.floor(at / counts.first), suffix: 0 });
    if (got) return got;
  }
  // 조합보다 명단이 큰 자리 — 풀을 줄이지 않는 한 닿지 않지만, 끝은 나야 한다
  for (let n = 2; ; n++) {
    const got = claim({ ...drawn, suffix: n });
    if (got) return got;
  }
}

const suffixed = (name: string, suffix: number) => (suffix === 0 ? name : `${name} ${suffix}`);

/**
 * 팀 안에서 겹치지 않는 합성 선수 이름 하나 — 한글 전체 이름이 유일성의 기준이다.
 * 화면이 읽는 것이 한글이고, 풀 안에서 한글과 로마자가 1:1이라 로마자도 함께 갈린다.
 */
export function claimSyntheticName(
  rng: () => number,
  pool: SyntheticNamePool,
  taken: Set<string>,
): SyntheticName {
  const nameAt = (slot: NameSlot): SyntheticName => ({
    ko: suffixed(`${pool.first[slot.first]!.ko} ${pool.last[slot.last]!.ko}`, slot.suffix),
    en: suffixed(`${pool.first[slot.first]!.en} ${pool.last[slot.last]!.en}`, slot.suffix),
  });
  const counts = { first: pool.first.length, last: pool.last.length };
  return nameAt(claimNameSlot(rng, counts, (slot) => nameAt(slot).ko, taken));
}

/** 한 세이브 안에서 겹치지 않는 가상 인물 이름 하나 */
export function claimPersonaName(
  rng: () => number,
  pool: PersonaNamePool,
  taken: Set<string>,
): string {
  const nameAt = (slot: NameSlot) =>
    suffixed(`${pool.given[slot.first]!} ${pool.family[slot.last]!}`, slot.suffix);
  const counts = { first: pool.given.length, last: pool.family.length };
  return nameAt(claimNameSlot(rng, counts, nameAt, taken));
}
