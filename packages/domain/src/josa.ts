/**
 * 한국어 조사 — **앞말이 고른다.**
 *
 * 코어가 쓰는 사실 문장에는 이름이 그대로 박힌다(`${name}이(가) …`). 「이(가)」·
 * 「은(는)」 같은 병기는 그 자리를 비워 두는 표기지 한국어가 아니다. 이 문장은
 * 화면의 키포인트 줄에도 서고 GM 스냅샷에도 실리므로, 한 게임에 수백 번 어색한
 * 말을 감독에게도 모델에게도 보여 준다 — 모델은 읽은 말투로 쓴다.
 *
 * 규칙은 하나다: **앞말의 마지막 소리에 받침이 있으면 앞쪽, 없으면 뒤쪽.**
 * 한글 음절은 유니코드가 `(초성×21 + 중성)×28 + 종성`으로 쌓여 있으므로
 * `(코드 − 0xAC00) % 28`이 그대로 종성 번호이고, 0이면 받침이 없다. 예외는 하나,
 * **「으로/로」의 ㄹ 받침**이다 — 「서울로」지 「서울으로」가 아니다.
 *
 * 자리가 여기인 이유는 **도메인·시뮬·엔진·화면이 같이 부르기 때문이다**
 * (AGENTS.md §5 「한 규칙, 한 정의」). 두 벌로 두면 한쪽만 고쳐진다.
 */

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
/** 종성의 가짓수 — 받침 없음(0)을 포함한 28 */
const TAIL_COUNT = 28;
/** 종성 표(` ㄱㄲㄳㄴㄵㄶㄷㄹ…`)에서 ㄹ이 앉은 번호 — 「으로/로」만 이 값을 따로 본다 */
const TAIL_RIEUL = 8;

/**
 * 로마자로 끝나는 이름은 **마지막 글자를 한국어로 읽은 소리**가 정한다 — 알파벳
 * 26자를 읽어 받침이 남는 것은 l(엘)·m(엠)·n(엔) 셋뿐이고 나머지는 모두 모음으로
 * 끝난다(비·씨·디·이·에프·지·에이치·아이·제이·케이·오·피·큐·아르·에스·티·유·
 * 브이·더블유·엑스·와이·지).
 *
 * 글자 읽기를 택한 이유는 **이 게임의 문장에 서는 로마자가 대개 약칭과 식별자**이기
 * 때문이다 — `RB`, `PSG`, `U21`, `nameEn`, 선수 슬러그. 약칭은 사람도 글자로 읽으므로
 * 이 규칙이 곧 정답이다. 낱말로 읽히는 이름은 대개 맞고(Kim 킴·Son 손·Park 파크),
 * 묵음 e가 붙은 꼴(Cole 콜)에서 어긋난다. 그 한 자리를 잡으려면 외래어 표기법 한 벌이
 * 들어와야 하고, 카탈로그의 이름은 애초에 한국어라 그 값을 못 한다.
 */
const TAILED_LETTERS = new Set(["l", "m", "n"]);

/**
 * 숫자는 **끝자리를 한국어로 읽은 소리**가 정한다 — 영·일·삼·육·칠·팔에 받침이
 * 남고 이·사·오·구에는 없다. 자릿수가 붙어도 끝자리가 0이면 읽는 말은 십·백·천
 * (「20」→이십)이라 역시 받침이 있으므로, 끝자리 하나만 봐도 어긋나지 않는다.
 */
const TAILED_DIGITS = new Set(["0", "1", "3", "6", "7", "8"]);
/** 그중 ㄹ로 끝나는 끝자리 — 일·칠·팔 */
const RIEUL_DIGITS = new Set(["1", "7", "8"]);

/** 소리를 갖지 않는 끝 — 괄호·따옴표·문장부호·공백은 그 앞 글자가 읽힌다 */
const SOUNDLESS = /[^0-9A-Za-z가-힣]/;

/**
 * 조사를 정하는 글자 — 뒤에서부터 **소리를 가진 첫 글자**다.
 *
 * 「홍길동(감독)」의 조사는 사람이 읽는 대로 「독」이 정한다. 괄호를 무시하고
 * 「동」으로 되돌아가면 표기와 발음이 갈린다.
 */
function soundingChar(word: string): string | undefined {
  for (let i = word.length - 1; i >= 0; i -= 1) {
    const ch = word[i];
    if (ch !== undefined && !SOUNDLESS.test(ch)) return ch;
  }
  return undefined;
}

/** 앞말의 끝소리 — 받침이 없는가, ㄹ인가, 그 밖인가 */
type FinalSound = "none" | "rieul" | "other";

/**
 * 읽을 글자가 없으면(빈 문자열, 부호뿐인 이름) **받침 없음**으로 본다 — 「가」·「는」·
 * 「를」은 받침 없는 이름에 붙는 꼴이고, 조사가 하나 빠진 문장보다 덜 튄다.
 */
function finalSound(word: string): FinalSound {
  const ch = soundingChar(word);
  if (ch === undefined) return "none";
  const code = ch.codePointAt(0) ?? 0;
  if (code >= HANGUL_FIRST && code <= HANGUL_LAST) {
    const tail = (code - HANGUL_FIRST) % TAIL_COUNT;
    return tail === 0 ? "none" : tail === TAIL_RIEUL ? "rieul" : "other";
  }
  if (ch >= "0" && ch <= "9") {
    return RIEUL_DIGITS.has(ch) ? "rieul" : TAILED_DIGITS.has(ch) ? "other" : "none";
  }
  const letter = ch.toLowerCase();
  return letter === "l" ? "rieul" : TAILED_LETTERS.has(letter) ? "other" : "none";
}

/** 앞말이 받침으로 끝나는가 */
export function hasFinalConsonant(word: string): boolean {
  return finalSound(word) !== "none";
}

/**
 * 쓸 수 있는 조사 짝 — **받침이 있을 때가 앞**이다. 표기가 규칙과 같은 순서로 서야
 * 새 짝을 더할 때 어느 쪽이 어느 쪽인지 다시 묻지 않는다.
 *
 * 「이라는/라는」은 감독이 부른 이름을 되돌려 주는 문장이 쓴다 — 「"손흥민"이라는
 * 선수를 찾지 못했습니다」. 앞말이 감독의 입력이라 받침이 매번 갈린다.
 */
export type JosaPair = "이/가" | "은/는" | "을/를" | "과/와" | "으로/로" | "이라는/라는";

/** ㄹ 받침이 뒤쪽을 따르는 유일한 짝 — 「서울로」·「기술로」지 「서울으로」가 아니다 */
const RIEUL_TAKES_BARE: JosaPair = "으로/로";

/** 조사만 — 앞말이 템플릿에서 떨어져 있어 `josa`로 붙일 수 없는 자리 */
export function josaOf(word: string, pair: JosaPair): string {
  const [tailed = "", bare = ""] = pair.split("/");
  const sound = finalSound(word);
  if (sound === "none") return bare;
  return sound === "rieul" && pair === RIEUL_TAKES_BARE ? bare : tailed;
}

/** 앞말에 조사를 붙인다 — 「달로」+「이/가」 → 「달로가」 */
export function josa(word: string, pair: JosaPair): string {
  return `${word}${josaOf(word, pair)}`;
}
