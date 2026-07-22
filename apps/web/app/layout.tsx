import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "story-fm",
  description: "말로 지휘하는 AI 풋볼 매니저",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
