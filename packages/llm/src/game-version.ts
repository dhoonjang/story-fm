/**
 * 게임 버전 — **모델이 받는 입력의 버전** (models.md §5-2).
 *
 * 원문 기록은 반년 뒤에도 열린다. 그때 그 응답이 지금과 같은 프롬프트·같은 도구·같은
 * 모델에서 나온 것인지 모르면, 두 응답의 차이가 모델의 변덕인지 우리가 바꾼 입력의
 * 결과인지 가릴 수 없다. 그래서 호출마다 이 값이 함께 남는다.
 *
 * 값은 `config/game-version.yml` 한 줄이 정본이고, 올리는 것은 사람과 에이전트의
 * 판단이다(`.claude/skills/game-version/SKILL.md`) — 코드가 자동으로 올리지 않는다.
 * 무엇이 「모델 입력의 변화」인지는 파일 경로만으로 갈리지 않기 때문이다.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { findConfigFile } from "./config";

const VERSION_RELATIVE_PATH = path.join("config", "game-version.yml");

/** major.minor.patch — 세 자리 숫자뿐이다 (프리릴리스도 빌드 메타도 두지 않는다) */
const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * 읽지 못했을 때의 값 — **기록이 게임을 멈추지는 않는다.**
 *
 * 설정이 깨져 있으면 모델 호출은 어차피 서지 못하지만, 버전 한 줄 때문에 턴이
 * 죽는 것은 과하다. 대신 기록에 남는 `0.0.0`이 「이 줄은 못 읽었다」를 말한다.
 */
const UNKNOWN_VERSION = "0.0.0";

export function parseGameVersion(source: string, label = VERSION_RELATIVE_PATH): string {
  const parsed: unknown = parse(source);
  const value =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { version?: unknown }).version
      : undefined;
  if (typeof value !== "string" || !SEMVER.test(value)) {
    throw new Error(`${label}의 version이 major.minor.patch가 아닙니다: ${String(value)}`);
  }
  return value;
}

/**
 * 프로세스 수명 동안 한 번 읽는다 — 버전이 오르는 때는 커밋이고, 그 커밋은 서버를
 * 다시 띄운다. 턴마다 파일을 여는 대신 여기 캐시가 선다.
 */
let cached: string | null = null;

export function gameVersion(): string {
  if (cached !== null) return cached;
  try {
    cached = parseGameVersion(readFileSync(findConfigFile(VERSION_RELATIVE_PATH), "utf8"));
  } catch (error) {
    console.warn(`[game-version] ${VERSION_RELATIVE_PATH}을 읽지 못했습니다:`, error);
    cached = UNKNOWN_VERSION;
  }
  return cached;
}
