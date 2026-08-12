/**
 * 선수 id — **소속 클럽이 들어가지 않는다.**
 *
 * 클럽은 바뀌고 id는 평생 그대로다. 클럽을 박아 두면 손흥민이 레알에서 뛰는데
 * id는 `tottenham-son`인 그림이 나온다 — 원장·어드민·GM 프롬프트가 모두 그 값을
 * 그대로 실어 나르므로, 지금 어디 소속인지를 두고 사람과 모델을 함께 속인다.
 *
 * id는 사람이 읽는다 (GM 프롬프트의 선수 명부가 이 값을 싣는다). 그래서 이름만으로
 * 유일하면 이름만 쓰고, 겹칠 때만 태어난 해를, 그래도 겹치면 번호를 덧붙인다.
 * 클럽과 무관한 것들만 붙으므로 이적해도 id가 거짓말이 되지 않는다.
 */

/** 로마자 이름 → 슬러그. NFD로 발음 구별 부호를 벗기고 비분해 문자는 수동 매핑 */
const SLUG_CHAR: Record<string, string> = {
  ø: "o",
  đ: "d",
  ð: "d",
  ł: "l",
  ß: "ss",
  æ: "ae",
  œ: "oe",
  þ: "th",
};

export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[øđðłßæœþ]/g, (c) => SLUG_CHAR[c] ?? "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 슬러그가 빈 이름(로마자가 하나도 없는 표기)의 자리 */
const NAMELESS = "player";

/**
 * 아직 안 쓰인 id를 하나 집어 `taken`에 등록한다.
 *
 * 등록까지 여기서 하는 이유: 부르는 쪽이 집합에 넣는 걸 잊으면 다음 선수가 같은
 * id를 받아 조용히 겹친다 — id의 유일성이 부르는 쪽의 기억력에 걸리면 안 된다.
 */
export function claimPlayerId(nameEn: string, birthdate: string, taken: Set<string>): string {
  const id = nextPlayerId(nameEn, birthdate, taken);
  taken.add(id);
  return id;
}

function nextPlayerId(nameEn: string, birthdate: string, taken: ReadonlySet<string>): string {
  const slug = slugifyName(nameEn) || NAMELESS;
  if (!taken.has(slug)) return slug;
  // 동명이인 — 태어난 해로 가른다
  const dated = `${slug}-${birthdate.slice(0, 4)}`;
  if (!taken.has(dated)) return dated;
  // 생년까지 같으면 남는 건 번호뿐이다
  for (let n = 2; ; n++) {
    const numbered = `${dated}-${n}`;
    if (!taken.has(numbered)) return numbered;
  }
}
