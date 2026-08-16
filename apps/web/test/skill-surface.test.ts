import { describe, expect, it } from "vitest";
import { SKILL_CATALOG } from "@story-fm/agents";
import { CARD_SKILLS, hasRailHint } from "../lib/panel-hints";

/**
 * **스킬 결과가 화면에 서는 길은 둘뿐이다** (game-overview §3).
 *
 * 1. **칩 + 말풍선** — 갈 장부가 있는 스킬. 그 턴에 바뀐 장부들이 탭 순서대로
 *    한 장씩 알림으로 서고, 채팅에 남은 칩을 누르면 그 말풍선이 다시 선다.
 * 2. **카드** — 갈 장부가 없는 스킬(협상·스카우트). 조건·확률·기한을 카드로 정리한다.
 *
 * 어느 쪽도 아니면 **아예 노출하지 않는다** — 조회 도구는 호출을 기록조차 하지
 * 않고(`read`), 코어가 한 일은 `silent`로 걸러진다. 이 테스트는 그 셋 밖으로
 * 새는 스킬(= 칩 속 줄글로만 남는 스킬)을 잡는다.
 */

/**
 * 경기 중에만 부를 수 있고 **장부에 흔적을 남기지 않는** 스킬 — 그때는 장부
 * 레일이 아예 서지 않고(`game-screen`은 경기 중 `PANELS`를 그리지 않는다) 지시는
 * 경기가 끝나면 사라진다. 그래서 갈 말풍선이 없다. 대신 증거는 **판세 뷰**가
 * 세운다 — 공략은 "공략 중"으로, 지역 플랜은 패킷의 새 키포인트로 선다
 * (`strength-packet.ts` — "지역 플랜: …"). 채팅에는 칩만 남는다.
 */
const MATCH_ONLY = new Set(["exploit_point", "set_match_plan"]);

/**
 * 코어가 한 일 — 늘 `silent`로 실려 칩이 되지 않는다. 경기 진행은 감독이 부른
 * 스킬이 아니라 시계를 민 결과이고, 그 결과는 중계와 스코어가 이미 말한다.
 */
const SILENT = new Set(["advance_match"]);

describe("스킬이 화면에 서는 길", () => {
  it("조작형 스킬은 모두 말풍선 아니면 카드다", () => {
    const orphans = SKILL_CATALOG.filter(
      (s) =>
        !s.readOnly &&
        !hasRailHint(s.name) &&
        !CARD_SKILLS.has(s.name) &&
        !MATCH_ONLY.has(s.name) &&
        !SILENT.has(s.name),
    ).map((s) => s.name);
    expect(orphans, "말풍선(PANEL_OF)이나 카드(CARD_SKILLS) 중 하나로 보내야 한다").toEqual([]);
  });

  it("조회 도구는 어느 쪽에도 없다 — 조회 로그는 화면에 서지 않는다", () => {
    for (const skill of SKILL_CATALOG.filter((s) => s.readOnly)) {
      expect(hasRailHint(skill.name) || CARD_SKILLS.has(skill.name), skill.name).toBe(false);
    }
  });

  it("한 스킬이 두 길을 함께 가지 않는다 — 같은 사실이 두 번 서면 안 된다", () => {
    const both = [...CARD_SKILLS].filter((name) => hasRailHint(name));
    expect(both).toEqual([]);
  });
});
