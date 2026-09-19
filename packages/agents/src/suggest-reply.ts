/**
 * **감독의 다음 말 하나** — GM 셋(평시·경기·협상 방)이 장면의 마지막 줄에
 * `<suggest_reply>…</suggest_reply>`로 낸다 (agents.md §2 · prompts.md §1).
 *
 * 도구가 아니라 **출력 문법**인 이유는 왕복이다. 도구로 받으면 턴마다 모델 호출이 하나
 * 늘고, GM이 쓰는 제공자에서는 그 호출의 입력이 캐시 없이 정가로 다시 읽힌다 — 대화만
 * 건 턴의 입력이 두 배가 된다. 태그 줄은 꺾쇠 블록이라 위생이 화면과 저장에서 함께
 * 걷는다(`sanitizeSceneText` · `filterSceneStream`). 여기서 하는 일은 걷히기 전에 **값을
 * 꺼내는 것**이고, 줄 한복판에 섞여 위생이 못 보는 태그도 함께 지운다. 값의 자리는
 * `GmTurnResult.suggestion` → `ChatTurn.suggestion` 하나다.
 */
export const SUGGEST_REPLY_TAG = "suggest_reply";

/** 한 문장의 상한 — 입력창 한 줄에 서는 길이다. 넘으면 그 턴엔 제안이 없다 */
export const SUGGESTION_MAX_CHARS = 80;

const TAG_RE = /<suggest_reply>([\s\S]*?)<\/suggest_reply>/gu;
/** 닫히지 않은 채 끝난 태그 — 잘린 응답이다. 값은 없고 꼬리만 지운다 */
const OPEN_TAIL_RE = /<suggest_reply>[\s\S]*$/u;
/** 모델이 문장을 인용 부호로 감쌀 때 — 감독이 보낼 말에 따옴표는 없다 */
const WRAPPING_QUOTES_RE = /^[“"'‘]+|[”"'’]+$/gu;

/**
 * 본문에서 제안을 **꺼낸다** — 첫 태그의 값을 돌려주고, 태그는 전부 지운 본문을 함께 낸다.
 * 값이 비었거나 상한을 넘으면 제안 없이 본문만 돌아온다.
 */
export function takeSuggestion(text: string): { text: string; suggestion?: string } {
  let first: string | undefined;
  const stripped = text
    .replace(TAG_RE, (_match, inner: string) => {
      first ??= inner;
      return "";
    })
    .replace(OPEN_TAIL_RE, "")
    .replace(/\n+$/u, "");
  const suggestion = first === undefined ? undefined : normalizeSuggestion(first);
  return { text: stripped, ...(suggestion === undefined ? {} : { suggestion }) };
}

function normalizeSuggestion(raw: string): string | undefined {
  const line = raw.replace(/\s+/gu, " ").trim().replace(WRAPPING_QUOTES_RE, "").trim();
  return line.length === 0 || line.length > SUGGESTION_MAX_CHARS ? undefined : line;
}
