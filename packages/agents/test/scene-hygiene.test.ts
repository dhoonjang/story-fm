import { describe, expect, it } from "vitest";
import { filterSceneStream, sanitizeSceneText } from "@story-fm/agents";

/**
 * 장면 위생 — **도구를 부르는 턴의 작업 로그가 대화에 섞이지 않는다.**
 *
 * 도구 반복마다 모델은 시점 헤더와 "…확인하겠습니다" 한 줄을 새로 찍는다.
 * 프롬프트로 눌러도 남는 습성이라 코어가 걷어낸다 — 출력 문법이 허락하는 줄은
 * 맨 앞 헤더 하나, `@`로 시작하는 줄, 빈 줄뿐이다.
 */
describe("sanitizeSceneText", () => {
  it("도구 앞 서술과 두 번째 헤더를 걷어낸다", () => {
    const raw = [
      "[2026-07-01 AM 9:45]",
      "소집 첫 주는 체력 위주로 잡겠습니다.",
      "[2026-07-01 AM 9:45]",
      "[2026-07-01 AM 9:45]",
      "소집 첫 주(7/13~7/18)를 새로 짜겠습니다.",
      "[2026-07-01 AM 9:45]",
      "@스티브 홀랜드: 첫 주는 다리부터 다시 만드는 걸로 채웠습니다.",
    ].join("\n");

    expect(sanitizeSceneText(raw)).toBe(
      [
        "[2026-07-01 AM 9:45]",
        "@스티브 홀랜드: 첫 주는 다리부터 다시 만드는 걸로 채웠습니다.",
      ].join("\n"),
    );
  });

  it("멀쩡한 장면은 그대로 둔다 (빈 줄은 문단 간격이다)", () => {
    const scene = ["[2026-07-01 AM 9:30]", "@: *문이 열린다*", "", "@손흥민: 감독님."].join("\n");
    expect(sanitizeSceneText(scene)).toBe(scene);
  });

  it("@ 줄이 하나도 없으면 손대지 않는다 — 빈 턴보다 어긴 장면이 낫다", () => {
    const broken = "오늘은 조용한 하루였습니다.";
    expect(sanitizeSceneText(broken)).toBe(broken);
  });
});

describe("filterSceneStream — 화면에도 같은 위생", () => {
  const run = (deltas: string[]) => {
    const out: string[] = [];
    const feed = filterSceneStream((d) => out.push(d));
    for (const d of deltas) feed(d);
    return out.join("");
  };

  it("걸러진 줄은 화면에 잠깐도 뜨지 않는다", () => {
    const text = run([
      "[2026-07-01 ",
      "AM 9:45]\n브루누의 ",
      "카드를 확인하겠습니다.\n",
      "[2026-07-01 AM 9:45]\n",
      "@스티브 홀랜드: 걱정할 게 ",
      "없습니다.",
    ]);
    expect(text).toBe("[2026-07-01 AM 9:45]\n@스티브 홀랜드: 걱정할 게 없습니다.");
  });

  it("살아남는 줄은 델타 그대로 흘러간다", () => {
    const out: string[] = [];
    const feed = filterSceneStream((d) => out.push(d));
    for (const d of ["@손", "흥민: 감독", "님."]) feed(d);
    // 첫 조각만 줄 앞머리 판정에 쓰이고, 그 뒤는 조각 단위로 그대로 나간다
    expect(out.join("")).toBe("@손흥민: 감독님.");
    expect(out.length).toBe(3);
  });
});
