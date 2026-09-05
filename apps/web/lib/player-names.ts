/**
 * ── 산문 속의 선수 이름 → 손잡이 ─────────────────────────────
 *
 * 장부의 줄은 id를 들고 있지만 **이야기는 이름밖에 없다**. 그 이름을 누를 수 있게
 * 하려면 이름에서 선수를 되찾아야 하고, 되찾는 자는 하나여야 한다 — 서버가 사전에
 * 무엇을 실을지 고르는 자리(`store.ts`의 `namesForChat`)와 화면이 문장을 가르는
 * 자리(`chat.tsx`)가 다른 규칙을 쓰면 사전에는 있는데 눌리지 않는 이름이 생긴다
 * (docs/data/player.md §9.5).
 *
 * 규칙은 셋이다.
 * - **긴 이름이 이긴다** — 「세너 라먼스」가 서면 성 하나로 다시 자르지 않는다.
 * - **성만 부른 이름은 사전 안에서 유일할 때만** 손잡이다. 동명이인은 어느 쪽인지
 *   알 수 없고, 모르면서 거는 손잡이는 틀린 카드를 연다.
 * - **앞이 한글이면 이름이 아니다** — 다른 이름의 꼬리를 자르지 않는다. 뒤는 열어
 *   둔다: 한국어는 이름에 조사가 붙는다(「라먼스가」).
 */

/**
 * 이름 사전 — 찾을 수 있는 이름과 그 선수. **한 번 지어 두고 여러 문장에 쓴다**
 * (문장마다 다시 지으면 채팅 한 화면이 사전을 백 번 짓는다).
 */
export interface PlayerNameIndex {
  /** 이름 → 선수 id. 어느 쪽인지 알 수 없는 이름은 아예 들어오지 않는다 */
  byName: Map<string, string>;
  /** 가장 긴 이름의 길이 — 자를 때 이 길이부터 내려온다 */
  longest: number;
  /** 이름이 시작할 수 있는 글자 — 대부분의 자리를 한 번의 조회로 건너뛴다 */
  heads: Set<string>;
}

/** 이름이 성립하는 가장 짧은 길이 — 한 글자 성은 아무 문장에나 걸린다 */
const MIN_NAME = 2;

const HANGUL = /[가-힣]/;
/**
 * 이름의 왼쪽에 붙어 있으면 안 되는 글자 — 글자·숫자·하이픈.
 * 하이픈까지 미는 것은 선수 id가 그 모양이기 때문이다(`arsenal-raya`) — 치환되지
 * 못하고 남은 id 한복판을 이름으로 자르면 손잡이가 엉뚱한 글자에 선다.
 */
const LEFT_BOUND = /[가-힣A-Za-z0-9-]/;
/** 오른쪽은 조사를 허용한다 — 한글이 아닌 글자·숫자만 이름을 부정한다 */
const WORD_CHAR = /[가-힣A-Za-z0-9]/;

/**
 * id→이름 사전을 **찾을 수 있는 사전**으로.
 *
 * 전체 이름을 먼저 넣고 성을 그 위에 얹는다 — 어떤 사람의 성이 다른 사람의 전체
 * 이름과 같으면 전체 이름이 이긴다(그 글자로 불릴 사람은 그쪽이다).
 */
export function buildPlayerNameIndex(names: Record<string, string>): PlayerNameIndex {
  const byName = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [id, name] of Object.entries(names)) {
    if (name.length < MIN_NAME) continue;
    const found = byName.get(name);
    if (found !== undefined && found !== id) ambiguous.add(name);
    else byName.set(name, id);
  }
  const surnames = new Map<string, string>();
  for (const [id, name] of Object.entries(names)) {
    const cut = name.lastIndexOf(" ");
    if (cut < 0) continue;
    const surname = name.slice(cut + 1);
    // 전체 이름으로 이미 선 글자는 건드리지 않는다 — 그 이름이 우선이다
    if (surname.length < MIN_NAME || byName.has(surname)) continue;
    const found = surnames.get(surname);
    if (found !== undefined && found !== id) ambiguous.add(surname);
    else surnames.set(surname, id);
  }
  for (const [surname, id] of surnames) byName.set(surname, id);
  for (const name of ambiguous) byName.delete(name);
  let longest = 0;
  const heads = new Set<string>();
  for (const name of byName.keys()) {
    longest = Math.max(longest, name.length);
    heads.add(name[0]!);
  }
  return { byName, longest, heads };
}

/** 문장 한 조각 — 이름이면 그 선수의 id가 붙는다 */
export interface ProsePiece {
  text: string;
  /** 이 조각이 가리키는 선수 — 이름이 아니면 없다 */
  playerId?: string;
}

/**
 * 문장을 이름 경계에서 가른다 — 맞는 이름이 없으면 **조각 하나**를 그대로 돌려준다.
 *
 * 사전에 없는 이름은 글자로 남는다: 리그 5,725명을 매 턴 실을 수 없으므로
 * (`namesForChat`) 사전은 우리 선수단과 이야기가 부른 선수뿐이고, 그 밖의 이름에
 * 손잡이가 없는 것은 고장이 아니라 사전의 폭이다.
 */
export function splitPlayerNames(text: string, index: PlayerNameIndex): ProsePiece[] {
  if (index.longest === 0 || text.length < MIN_NAME) return [{ text }];
  const pieces: ProsePiece[] = [];
  let plain = "";
  for (let i = 0; i < text.length;) {
    const id = index.heads.has(text[i]!) ? matchAt(text, i, index) : null;
    if (id === null) {
      plain += text[i];
      i += 1;
      continue;
    }
    if (plain !== "") pieces.push({ text: plain });
    plain = "";
    pieces.push({ text: id.name, playerId: id.playerId });
    i += id.name.length;
  }
  if (plain !== "") pieces.push({ text: plain });
  return pieces.length === 0 ? [{ text }] : pieces;
}

/** 이 자리에서 시작하는 가장 긴 이름 — 없으면 null */
function matchAt(
  text: string,
  at: number,
  index: PlayerNameIndex,
): { name: string; playerId: string } | null {
  // 앞 글자에 붙어 있으면 이름의 시작이 아니다
  if (at > 0 && LEFT_BOUND.test(text[at - 1]!)) return null;
  for (let len = Math.min(index.longest, text.length - at); len >= MIN_NAME; len -= 1) {
    const name = text.slice(at, at + len);
    const playerId = index.byName.get(name);
    if (playerId === undefined) continue;
    /**
     * 뒤가 한글이면 조사이거나(「라먼스가」) 더 긴 이름의 일부인데, 더 긴 이름은
     * 위 순회가 이미 봤다 — 남은 것은 조사뿐이라 그대로 끊는다. 뒤가 영문·숫자면
     * 이름이 아니다(`arsenal-…` 같은 id 토큰의 한복판).
     */
    const after = text[at + len];
    if (after !== undefined && !HANGUL.test(after) && WORD_CHAR.test(after)) continue;
    return { name, playerId };
  }
  return null;
}

/** 이 문장이 부르는 선수 전부 — 서버가 사전에 무엇을 실을지 고를 때 쓴다 */
export function playerIdsIn(text: string, index: PlayerNameIndex): string[] {
  const ids: string[] = [];
  for (const piece of splitPlayerNames(text, index)) {
    if (piece.playerId !== undefined) ids.push(piece.playerId);
  }
  return ids;
}
