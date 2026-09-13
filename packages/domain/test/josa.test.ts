import { describe, expect, it } from "vitest";
import { hasFinalConsonant, josa, josaOf } from "@story-fm/domain";

/** 조사는 앞말이 고른다 — 받침 하나로 갈린다 (josa.ts) */

describe("josa — 한글 이름", () => {
  it("받침이 있으면 이·은·을·과", () => {
    expect(josa("손흥민", "이/가")).toBe("손흥민이");
    expect(josa("황희찬", "은/는")).toBe("황희찬은");
    expect(josa("김민재", "을/를")).toBe("김민재를"); // 재 — 받침 없음
    expect(josa("이강인", "과/와")).toBe("이강인과");
  });

  it("받침이 없으면 가·는·를·와 — 이슈 #783이 센 이름들", () => {
    expect(josa("맨체스터 유나이티드", "이/가")).toBe("맨체스터 유나이티드가");
    expect(josa("코비 마이누", "은/는")).toBe("코비 마이누는");
    expect(josa("니코 슐로터베크", "은/는")).toBe("니코 슐로터베크는");
    expect(josa("디오구 달로", "이/가")).toBe("디오구 달로가");
    expect(josa("마누엘 우가르테", "은/는")).toBe("마누엘 우가르테는");
    expect(josa("RB 라이프치히", "이/가")).toBe("RB 라이프치히가");
    expect(josa("선더랜드", "이/가")).toBe("선더랜드가");
  });

  it("받침은 종성 번호가 0이 아닌 것 — 음절 블록의 끝과 처음", () => {
    expect(hasFinalConsonant("가")).toBe(false); // 0xAC00, 종성 0
    expect(hasFinalConsonant("각")).toBe(true); // 0xAC01, 종성 1
    expect(hasFinalConsonant("힣")).toBe(true); // 0xD7A3, 종성 27
    expect(hasFinalConsonant("히")).toBe(false);
  });
});

describe("josa — 로마자·숫자로 끝나는 이름", () => {
  it("마지막 글자를 한국어로 읽는다 — 받침이 남는 것은 l·m·n뿐", () => {
    expect(josa("Kim", "이/가")).toBe("Kim이");
    expect(josa("Son", "이/가")).toBe("Son이");
    expect(josa("Park", "이/가")).toBe("Park가");
    expect(josa("Ronaldo", "은/는")).toBe("Ronaldo는");
    expect(josa("Diaz", "을/를")).toBe("Diaz를");
  });

  it("약칭은 대소문자를 가리지 않는다 — 사람도 글자로 읽는 자리다", () => {
    expect(josa("ARSENAL", "이/가")).toBe("ARSENAL이");
    expect(josa("PSG", "이/가")).toBe("PSG가");
    expect(josa("rb", "이/가")).toBe("rb가");
  });

  it("숫자는 끝자리를 읽는다 — 영·일·삼·육·칠·팔에 받침이 있다", () => {
    expect(josa("3", "은/는")).toBe("3은");
    expect(josa("7", "이/가")).toBe("7이");
    expect(josa("2", "은/는")).toBe("2는");
    expect(josa("9", "이/가")).toBe("9가");
    expect(josa("10", "은/는")).toBe("10은"); // 십
    expect(josa("20", "은/는")).toBe("20은"); // 이십
  });
});

describe("josa — 소리가 없는 끝", () => {
  it("괄호·따옴표는 그 앞 글자가 읽힌다", () => {
    expect(josa("홍길동(감독)", "이/가")).toBe("홍길동(감독)이");
    expect(josa("케인(FW)", "은/는")).toBe("케인(FW)는"); // 더블유 — 받침 없음
  });

  it("읽을 글자가 없으면 받침 없음으로 본다", () => {
    expect(josa("", "이/가")).toBe("가");
    expect(josa("···", "은/는")).toBe("···는");
  });
});

describe("josa — 「으로/로」의 ㄹ 예외", () => {
  it("ㄹ 받침은 받침 없는 쪽을 따른다", () => {
    expect(josa("서울", "으로/로")).toBe("서울로");
    expect(josa("기술", "으로/로")).toBe("기술로");
    expect(josa("리버풀", "으로/로")).toBe("리버풀로");
  });

  it("ㄹ이 아닌 받침은 「으로」, 받침이 없으면 「로」", () => {
    expect(josa("웨스트햄", "으로/로")).toBe("웨스트햄으로");
    expect(josa("체력", "으로/로")).toBe("체력으로");
    expect(josa("첼시", "으로/로")).toBe("첼시로");
    expect(josa("선더랜드", "으로/로")).toBe("선더랜드로");
  });

  it("로마자·숫자에도 같은 예외가 걸린다 — 엘·일·칠·팔이 ㄹ이다", () => {
    expect(josa("Arsenal", "으로/로")).toBe("Arsenal로");
    expect(josa("7", "으로/로")).toBe("7로");
    expect(josa("3", "으로/로")).toBe("3으로");
  });

  it("다른 짝은 ㄹ을 가리지 않는다", () => {
    expect(josa("서울", "이/가")).toBe("서울이");
    expect(josa("서울", "은/는")).toBe("서울은");
  });
});

describe("josaOf — 조사만", () => {
  it("앞말이 떨어져 있는 자리에 쓴다", () => {
    expect(josaOf("손흥민", "이/가")).toBe("이");
    expect(josaOf("달로", "이/가")).toBe("가");
    expect(josaOf("선더랜드", "과/와")).toBe("와");
  });
});
