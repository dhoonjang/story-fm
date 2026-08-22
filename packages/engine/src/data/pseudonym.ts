/**
 * 가명 매핑 — **문자열만 바꾸고 조인은 지킨다** (sources.md §7.3).
 *
 * 여기 있는 것은 전부 문자열 → 문자열 순수 함수다. 파일을 읽지도 쓰지도 않고
 * 카탈로그를 부르지도 않는다 — 나라·시드는 부르는 쪽(`scripts/pseudonymize.ts`)이
 * 넘긴다. 그래야 매핑을 테스트하는 데 세계가 필요 없다.
 *
 * 세 가지가 이 파일의 모양을 정한다.
 *
 * ① **결정적이다.** 난수는 전부 입력 문자열의 해시에서 나온다. 같은 입력은 언제나
 *    같은 가명을 내므로 파이프라인을 두 번 돌려도 세계가 흔들리지 않고, 두 실행의
 *    diff가 곧 시드 변경분이다.
 * ② **유일성은 부르는 쪽의 기억력에 걸리지 않는다.** `taken` 집합을 함수가 직접
 *    들고 등록한다 (`names.ts`의 `claim*`과 같은 이유). 한 클럽 안에 동명이인이
 *    서면 화자 태그가 무너지고(people.md §2), shortName이 겹치면 리그를 넘나드는
 *    표시가 갈리지 않는다.
 * ③ **사람 이름 풀은 `names.ts` 그것을 쓴다.** 절차 생성 선수가 이미 쓰는 풀이라
 *    전환 뒤에도 실명 자리와 합성 자리가 같은 모양으로 읽힌다. 여기서 새로
 *    만드는 풀은 사람이 아닌 것 — 지명과 시설어뿐이다.
 *
 * ⚠️ **등번호·능력치는 여기서 다루지 않는다.** 번호를 비우는 것은 파이프라인의
 * 일이고(§7.5), 능력치·시장가·주급을 자체 산정으로 바꾸는 것은 `world/synthesis.ts`
 * 쪽 갈래다 (§7.1 생성). 이름만 바꾸는 것은 절반이라는 것이 Keller 판례의 요지다.
 */
import { hashOf } from "../world/name-hash";
import { makeRng } from "../core/rng";
import { claimSyntheticName, syntheticNamePoolOf } from "./names";

/** 지명 하나 — 한글은 화면이, 로마자는 shortName이 읽는다 */
interface Place {
  ko: string;
  en: string;
}

/**
 * 클럽·구장이 서는 지명 풀 — **지어낸 땅이다.** 실제 도시를 쓰면 그 도시의 유일한
 * 클럽을 오히려 더 또렷하게 지목하고, 실존 지명과의 일치는 이름 풀과 마찬가지로
 * 우연이다 (`names.ts`).
 *
 * 나라마다 나누는 이유도 이름 풀과 같다 — 세리에A 클럽이 통째로 잉글랜드 지명을
 * 쓰면 리그의 색이 사라진다. 나라당 24개면 그 나라 32클럽(1부 20 + 2부 12)에
 * 형태를 곱해 조합이 남는다.
 */
const PLACE_POOLS: Record<string, readonly Place[]> = {
  잉글랜드: [
    { ko: "애시윅", en: "Ashwick" },
    { ko: "브램퍼드", en: "Bramford" },
    { ko: "코브리지", en: "Corbridge" },
    { ko: "덴홈", en: "Denholm" },
    { ko: "이스트미어", en: "Eastmere" },
    { ko: "펜윅", en: "Fenwick" },
    { ko: "그림스데일", en: "Grimsdale" },
    { ko: "해로게이트", en: "Harrowgate" },
    { ko: "아이언브리지", en: "Ironbridge" },
    { ko: "켈브룩", en: "Kelbrook" },
    { ko: "랭무어", en: "Langmoor" },
    { ko: "마치우드", en: "Marchwood" },
    { ko: "네더비", en: "Netherby" },
    { ko: "오크햄프턴", en: "Oakhampton" },
    { ko: "펜힐", en: "Pennhill" },
    { ko: "레드마시", en: "Redmarsh" },
    { ko: "스톤웰", en: "Stonewell" },
    { ko: "손베리", en: "Thornbury" },
    { ko: "어퍼크로스", en: "Uppercross" },
    { ko: "웩스브리지", en: "Wexbridge" },
    { ko: "야로미어", en: "Yarrowmere" },
    { ko: "블랙무어", en: "Blackmoor" },
    { ko: "크로허스트", en: "Crowhurst" },
    { ko: "드레이콧", en: "Draycott" },
  ],
  스페인: [
    { ko: "알코레나", en: "Alcorena" },
    { ko: "베르메다", en: "Bermeda" },
    { ko: "칼라노바", en: "Calanova" },
    { ko: "두라도", en: "Durado" },
    { ko: "에스파랄", en: "Esparral" },
    { ko: "푸엔텔라르", en: "Fuentelar" },
    { ko: "그라날바", en: "Granalba" },
    { ko: "오르니요스", en: "Hornillos" },
    { ko: "이베르나", en: "Iberna" },
    { ko: "하랄타", en: "Jaralta" },
    { ko: "로마레스", en: "Lomares" },
    { ko: "미랄바", en: "Miralba" },
    { ko: "나바레다", en: "Navarreda" },
    { ko: "올리바레스", en: "Olivares" },
    { ko: "페냘타", en: "Penalta" },
    { ko: "킨타나르", en: "Quintanar" },
    { ko: "리발바", en: "Ribalva" },
    { ko: "솔베라", en: "Solvera" },
    { ko: "토랄바", en: "Torralba" },
    { ko: "우르베카", en: "Urbeca" },
    { ko: "발데크루스", en: "Valdecruz" },
    { ko: "사프랄레호", en: "Zafralejo" },
    { ko: "몬티하르", en: "Montijar" },
    { ko: "세랄보", en: "Cerralbo" },
  ],
  이탈리아: [
    { ko: "알바로네", en: "Albarone" },
    { ko: "브렌톨라", en: "Brentola" },
    { ko: "카스텔무로", en: "Castelmuro" },
    { ko: "도리아노", en: "Doriano" },
    { ko: "에르바노바", en: "Erbanova" },
    { ko: "팔도리아", en: "Faldoria" },
    { ko: "그리말도", en: "Grimaldo" },
    { ko: "이솔리나", en: "Isolina" },
    { ko: "루체르노", en: "Lucerno" },
    { ko: "몬탈베라", en: "Montalvera" },
    { ko: "노바리나", en: "Novarina" },
    { ko: "오르텐치아", en: "Ortenzia" },
    { ko: "피에트라스코", en: "Pietrasco" },
    { ko: "콰르티나", en: "Quartina" },
    { ko: "로발도", en: "Rovaldo" },
    { ko: "사벨리노", en: "Sabellino" },
    { ko: "토르나리아", en: "Tornaria" },
    { ko: "우르바넬라", en: "Urbanella" },
    { ko: "발덴차", en: "Valdenza" },
    { ko: "체르바노", en: "Zerbano" },
    { ko: "콜마뇨", en: "Colmagno" },
    { ko: "페랄타", en: "Ferralta" },
    { ko: "마렌도", en: "Marendo" },
    { ko: "산시모네", en: "Sansimone" },
  ],
  독일: [
    { ko: "알텐바흐", en: "Altenbach" },
    { ko: "베르크슈테트", en: "Bergstedt" },
    { ko: "크로나우", en: "Cronau" },
    { ko: "도른펠트", en: "Dornfeld" },
    { ko: "아이히발트", en: "Eichwald" },
    { ko: "팔켄슈타인", en: "Falkenstein" },
    { ko: "그륀하우젠", en: "Grunhausen" },
    { ko: "홀렌바흐", en: "Hollenbach" },
    { ko: "이젠부르크", en: "Isenburg" },
    { ko: "칼트브룬", en: "Kaltbrunn" },
    { ko: "린데나우", en: "Lindenau" },
    { ko: "모어슈테트", en: "Moorstedt" },
    { ko: "노이발데", en: "Neuwalde" },
    { ko: "오스트펠트", en: "Ostfeld" },
    { ko: "포르츠바흐", en: "Pforzbach" },
    { ko: "크벨슈타트", en: "Quellstadt" },
    { ko: "로테나우", en: "Rothenau" },
    { ko: "슈타인브뤼크", en: "Steinbruck" },
    { ko: "탄베르크", en: "Tannberg" },
    { ko: "울렌호르스트", en: "Uhlenhorst" },
    { ko: "포크트하임", en: "Vogtheim" },
    { ko: "베른슈테트", en: "Wernstedt" },
    { ko: "첸베르크", en: "Zehnberg" },
    { ko: "말베크", en: "Mahlbeck" },
  ],
  프랑스: [
    { ko: "오베르네", en: "Aubernay" },
    { ko: "보클레르", en: "Beauclair" },
    { ko: "샹브라크", en: "Chamberac" },
    { ko: "두르빌", en: "Dourville" },
    { ko: "에스탕주", en: "Estanges" },
    { ko: "퐁트리외", en: "Fontrieu" },
    { ko: "그랑몽", en: "Grandmont" },
    { ko: "오트리브", en: "Hautrive" },
    { ko: "이즈락", en: "Iserac" },
    { ko: "주방스", en: "Jouvence" },
    { ko: "라샤펠", en: "Lachapelle" },
    { ko: "마르나발", en: "Marnaval" },
    { ko: "누아르몽", en: "Noirmont" },
    { ko: "오르브나크", en: "Orbenac" },
    { ko: "퐁샤름", en: "Pontcharme" },
    { ko: "키야크", en: "Quillac" },
    { ko: "로슈빌", en: "Rocheville" },
    { ko: "사를란", en: "Sarlanne" },
    { ko: "투른메르", en: "Tournemer" },
    { ko: "위상주", en: "Ussange" },
    { ko: "발미에", en: "Valmiers" },
    { ko: "베르클로", en: "Verclos" },
    { ko: "토므리", en: "Thaumery" },
    { ko: "몽테클레르", en: "Monteclair" },
  ],
  사우디아라비아: [
    { ko: "알카람", en: "Al-Kharam" },
    { ko: "알와딘", en: "Al-Wadeen" },
    { ko: "알파리안", en: "Al-Faryan" },
    { ko: "알나딤", en: "Al-Nadeem" },
    { ko: "알사흐라", en: "Al-Sahra" },
    { ko: "알타미르", en: "Al-Tamir" },
    { ko: "알자흐란", en: "Al-Zahran" },
    { ko: "알바히르", en: "Al-Bahir" },
  ],
  미국: [
    { ko: "페어헤이븐", en: "Fairhaven" },
    { ko: "리버턴", en: "Riverton" },
    { ko: "노스게이트", en: "Northgate" },
    { ko: "실버포트", en: "Silverport" },
    { ko: "베이우드", en: "Baywood" },
    { ko: "크레스트라인", en: "Crestline" },
    { ko: "레이크쇼어", en: "Lakeshore" },
    { ko: "하이포인트", en: "Highpoint" },
  ],
};

/**
 * 클럽 이름의 형태 — `{}` 자리에 지명이 들어간다. 나라마다 다른 이유는 지명과
 * 같다: 접두형(AC·올랭피크)과 접미형(시티·칼초)이 리그의 색을 만든다.
 */
const CLUB_FORMS: Record<string, readonly string[]> = {
  잉글랜드: ["{} FC", "{} 시티", "{} 유나이티드", "{} 로버스", "{} 타운", "{} 애슬레틱"],
  스페인: ["{} CF", "데포르티보 {}", "아틀레티코 {}", "유니온 {}", "CD {}", "{} 발롬피에"],
  이탈리아: ["{} 칼초", "AC {}", "US {}", "SS {}", "{} FC", "AS {}"],
  독일: ["FC {}", "SV {}", "TSV {}", "VfL {}", "SC {}", "FSV {}"],
  프랑스: ["{} FC", "올랭피크 {}", "스타드 {}", "AS {}", "RC {}", "US {}"],
  사우디아라비아: ["{}", "{} SC", "{} FC"],
  미국: ["{} FC", "{} SC", "{} 유나이티드", "스포팅 {}", "{} 시티"],
};

/**
 * 구장 이름의 형태 — 클럽이 뽑은 **그 지명**에 얹는다. 클럽만 바꾸고 구장을 두면
 * "가명 클럽이 안필드를 쓴다"가 되어 오히려 더 또렷하게 지목한다 (§7.3).
 */
const STADIUM_FORMS: Record<string, readonly string[]> = {
  잉글랜드: ["{} 스타디움", "{} 파크", "{} 로드", "{} 그라운드", "{} 아레나"],
  스페인: ["에스타디오 {}", "에스타디오 데 {}", "캄포 데 {}", "콜리세오 {}"],
  이탈리아: ["스타디오 {}", "스타디오 코무날레 {}", "아레나 {}", "스타디오 델 {}"],
  독일: ["{} 아레나", "{} 슈타디온", "{}-파르크", "발트슈타디온 {}"],
  프랑스: ["스타드 {}", "파르크 {}", "스타드 뮈니시팔 {}", "스타드 올랭피크 {}"],
  사우디아라비아: ["{} 스타디움", "{} 아레나", "{} 파크"],
  미국: ["{} 스타디움", "{} 필드", "{} 파크"],
};

/** 풀이 없는 나라가 떨어지는 자리 — `names.ts`의 `FALLBACK_NAME_COUNTRY`와 같은 규칙 */
const FALLBACK_PLACE_COUNTRY = "잉글랜드";

function poolOf<T>(table: Record<string, readonly T[]>, country: string | null | undefined) {
  return (country != null ? table[country] : undefined) ?? table[FALLBACK_PLACE_COUNTRY]!;
}

/** 입력 문자열 하나에서 시작하는 난수 — 여기가 결정성의 뿌리다 (위 ①) */
function rngFor(key: string): () => number {
  return makeRng(hashOf(key));
}

/**
 * 지명 × 형태 조합에서 아직 안 쓰인 자리 하나 — 고르고 `taken`에 등록한다.
 *
 * 한 번 뽑고, 겹치면 남은 조합을 결정적으로 훑고, 조합이 동나면 번호를 붙인다.
 * 어느 갈래든 같은 키는 같은 결과를 낸다.
 */
function claimCombo(
  key: string,
  places: readonly Place[],
  forms: readonly string[],
  taken: Set<string>,
): { place: Place; text: string } {
  const total = places.length * forms.length;
  const start = Math.floor(rngFor(key)() * total);
  for (let step = 0; step < total; step++) {
    const at = (start + step) % total;
    const place = places[at % places.length]!;
    const text = forms[Math.floor(at / places.length)]!.replace("{}", place.ko);
    if (!taken.has(text)) {
      taken.add(text);
      return { place, text };
    }
  }
  // 조합보다 클럽이 많은 자리 — 풀을 줄이지 않는 한 닿지 않지만, 끝은 나야 한다
  const place = places[start % places.length]!;
  for (let n = 2; ; n++) {
    const text = `${forms[0]!.replace("{}", place.ko)} ${n}`;
    if (!taken.has(text)) {
      taken.add(text);
      return { place, text };
    }
  }
}

/**
 * 로마자 지명 → 세 글자 약어. **전 클럽에서 유일해야 한다** — 리그를 넘나드는
 * 표시라 겹치면 두 클럽이 같은 얼굴로 선다 (team-catalog.ts 최상단).
 */
function claimShortName(en: string, taken: Set<string>): string {
  const letters = en.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const head = letters.slice(0, 2).padEnd(2, "X");
  const candidates = [
    letters.slice(0, 3).padEnd(3, "X"),
    // 앞 두 글자를 남기고 뒷글자를 바꾼다 — 같은 지명의 두 클럽이 갈리는 자리
    ...Array.from(letters.slice(3), (c) => head + c),
    ...Array.from({ length: 8 }, (_, i) => head + String(i + 2)),
  ];
  for (const candidate of candidates) {
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  for (let n = 2; ; n++) {
    const candidate = `${letters.slice(0, 1) || "X"}${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/** 가명 선수 이름 — 표시 이름 둘뿐이다. 생년월일·능력치·id는 그대로 남는다 */
export interface PlayerPseudonym {
  nameKo: string;
  nameEn: string;
}

/** 선수를 가리는 데 필요한 최소 — 시드 전체를 넘겨도 이 셋만 읽는다 */
export interface PlayerNameInput {
  nameEn: string;
  birthdate: string;
  /** 있으면 이것이 사람을 가리는 키다 — 동명이인이 같은 가명을 받지 않는다 */
  wikidataId?: string;
}

/**
 * 선수 하나를 가리는 키 — **이 값이 그 선수의 가명을 정한다.**
 *
 * 명단에서의 순서가 아니라 사람이 키라서, 시드에 선수 하나가 끼어들어도 나머지
 * 명단의 가명이 밀리지 않는다. 두 실행의 diff가 곧 시드 변경분이라는 것(§7.3)이
 * 여기에 걸려 있다.
 */
export function playerNameKey(seed: PlayerNameInput): string {
  return seed.wikidataId ?? `${seed.nameEn}|${seed.birthdate}`;
}

/**
 * 한 클럽의 명단을 통째로 가명으로 옮긴다 — **입력 순서 그대로** 돌려준다.
 *
 * 한 클럽 안에서 이름이 겹치면 안 된다 (people.md §2 — 태그는 전역 유일이라
 * 동명이인이 서면 화자 판별이 무너진다). 겹칠 때 누가 원래 이름을 받는지는
 * 키 순서가 정하므로, 명단이 재배열돼도 결과가 같다.
 */
export function pseudonymSquad(
  country: string | null | undefined,
  seeds: readonly PlayerNameInput[],
): readonly PlayerPseudonym[] {
  const pool = syntheticNamePoolOf(country);
  const taken = new Set<string>();
  const claimed = new Map<string, PlayerPseudonym>();
  const order = seeds
    .map((seed, at) => ({ key: playerNameKey(seed), at }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.at - b.at));
  for (const { key } of order) {
    if (claimed.has(key)) continue;
    const name = claimSyntheticName(rngFor(`pseudonym:player:${key}`), pool, taken);
    claimed.set(key, { nameKo: name.ko, nameEn: name.en });
  }
  return seeds.map((seed) => claimed.get(playerNameKey(seed))!);
}

/** 클럽 하나를 가리는 최소 — id는 바뀌지 않으므로 그대로 키다 */
export interface ClubNameInput {
  id: string;
  country: string | null;
}

/** 클럽·구장은 한 묶음이다 — 따로 바꾸면 가명 클럽이 실제 구장을 쓴다 (§7.3) */
export interface ClubPseudonym {
  name: string;
  shortName: string;
  stadium: string;
}

/**
 * 클럽 전체를 한 번에 옮긴다 — **전 클럽을 한 자리에서 봐야** shortName의 유일성과
 * 구장 이름의 중복을 막을 수 있다. 그래서 클럽 하나짜리 함수를 두지 않는다.
 *
 * 클럽 id 순으로 집으므로 카탈로그의 나열 순서가 바뀌어도 결과가 같다.
 */
export function pseudonymClubs(clubs: readonly ClubNameInput[]): Map<string, ClubPseudonym> {
  const takenName = new Set<string>();
  const takenShort = new Set<string>();
  const takenStadium = new Set<string>();
  const out = new Map<string, ClubPseudonym>();
  for (const club of [...clubs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const places = poolOf(PLACE_POOLS, club.country);
    const forms = poolOf(CLUB_FORMS, club.country);
    const { place, text } = claimCombo(`pseudonym:club:${club.id}`, places, forms, takenName);
    const stadium = claimCombo(
      `pseudonym:stadium:${club.id}`,
      [place],
      poolOf(STADIUM_FORMS, club.country),
      takenStadium,
    ).text;
    out.set(club.id, {
      name: text,
      shortName: claimShortName(place.en, takenShort),
      stadium,
    });
  }
  return out;
}

/** 리그 이름을 정하는 데 필요한 것 — 이름은 나라와 하는 일에서 나온다 */
export interface LeagueNameInput {
  name: string;
  country: string;
  kind: "playable" | "cup-only" | "market-only" | "free";
}

/**
 * 리그 가명 — **나라 + 하는 일**로 짓는다.
 *
 * 지명처럼 풀에서 뽑지 않는 이유는 리그 이름이 클럽 이름과 성격이 다르기
 * 때문이다. "프리미어리그"·"라리가"는 상표지만 "잉글랜드 1부 리그"는 사실을
 * 적은 말이라 상표가 될 수 없고, 리그가 늘어도 손댈 표가 없다.
 *
 * 무소속(`free`)은 리그가 아니라 리그 밖이라 이름을 바꾸지 않는다 —
 * 상표 대상이 아니고, 바꾸면 화면이 뜻을 잃는다.
 */
export function pseudonymLeague(entry: LeagueNameInput): string {
  if (entry.kind === "free") return entry.name;
  if (entry.kind === "market-only") return `${entry.country} 프로 리그`;
  return `${entry.country} ${entry.kind === "playable" ? 1 : 2}부 리그`;
}
