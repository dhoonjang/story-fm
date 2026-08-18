import { z } from "zod";

/**
 * 게임 안의 모든 날짜는 `YYYY-MM-DD` 하나로만 적는다 — 시각도 시간대도 없다.
 * 세이브에 그대로 담기는 형식이라, 검증하는 자리가 늘어나도 표현은 하나여야 한다.
 */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `DATE_PATTERN`을 강제하는 날짜 문자열 스키마 */
export const DateString = z.string().regex(DATE_PATTERN);
