import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "story-fm",
  description: "말로 지휘하는 AI 풋볼 매니저",
  /** `translate="no"`를 못 읽는 번역기에도 같은 말을 한다 */
  other: { google: "notranslate" },
};

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
      <body>{children}</body>
    </html>
  );
}
