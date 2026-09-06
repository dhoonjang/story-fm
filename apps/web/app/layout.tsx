import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "story-fm",
  description: "말로 지휘하는 AI 풋볼 매니저",
  /** `translate="no"`를 못 읽는 번역기에도 같은 말을 한다 */
  other: { google: "notranslate" },
};

/**
 * 먼저 부르는 서체 조각 — 셸 어휘(스쿼드 · 달력 · 재정 · 대회 · 커리어 · 회견 · 수석코치 ·
 * 경기 · 채팅 · 감독 · 훈련 · 선수)가 닿는 Pretendard 다이내믹 서브셋 일곱 조각과, 화면
 * 문자열 전체에서 그다음으로 많이 쓰이는 86번. 나머지 84조각은 글자가 서는 순간
 * `unicode-range`가 부른다. 선언은 styles/fonts.css에 있다.
 */
const PRELOADED_PRETENDARD_PIECES = [79, 85, 86, 87, 88, 89, 90, 91] as const;

const PRELOADED_FONTS = [
  ...PRELOADED_PRETENDARD_PIECES.map(
    (n) => `/fonts/pretendard/PretendardVariable.subset.${n}.woff2`,
  ),
  "/fonts/barlow-condensed/BarlowCondensed-600-latin.woff2",
  "/fonts/barlow-condensed/BarlowCondensed-700-latin.woff2",
];

/**
 * `translate="no"` — **브라우저 자동 번역을 끈다.**
 *
 * 화면이 통째로 한국어라 기기 언어가 다르면 번역기가 붙는데, 그것이 React가
 * 하이드레이션하기 **전에** 텍스트 노드를 갈아 끼워 서버가 그린 것과 어긋난다.
 * 붙은 뒤에도 문제다 — 번역기는 React가 쥐고 있는 DOM을 계속 바꾸고, 채팅처럼
 * 매 턴 다시 그리는 자리에서는 그 둘이 같은 노드를 두고 다툰다.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" translate="no">
      <head>
        {PRELOADED_FONTS.map((href) => (
          <link
            key={href}
            rel="preload"
            as="font"
            type="font/woff2"
            href={href}
            crossOrigin="anonymous"
          />
        ))}
      </head>
      <body>{children}</body>
    </html>
  );
}
