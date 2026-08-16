import { describe, expect, it } from "vitest";
import { SKILL_CATALOG } from "@story-fm/agents";
import { SKILL_LABEL } from "../lib/skill-label";

/**
 * 표시 이름은 웹이 갖는다(카탈로그를 직접 import하면 `node:path`가 딸려 와
 * 클라이언트 번들이 깨진다). 대신 **어긋나지 않는지는 여기서 지킨다.**
 */
describe("스킬 표시 이름", () => {
  it("카탈로그와 같은 이름을 쓴다", () => {
    for (const skill of SKILL_CATALOG) {
      expect(SKILL_LABEL[skill.name], skill.name).toBe(skill.label);
    }
  });
});
