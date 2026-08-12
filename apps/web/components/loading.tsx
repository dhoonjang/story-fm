import { IconMark } from "@/components/icons";

/**
 * 불러오는 중 — **글자 대신 마크.** 화면이 통째로 아직 없는 자리에만 쓴다.
 *
 * "불러오는 중…"이라 적으면 그 문장이 화면의 첫 인상이 되고, 곧 사라질 텍스트가
 * 제목 자리를 잡는다. 로고(공-말풍선)를 그 자리에 세우고 바깥으로 호 하나를
 * 돌리면 읽지 않아도 기다리는 중임을 안다. 문장은 낭독기에만 전한다.
 *
 * 화면의 **한 구획**이 오는 중이라면 `LoadingInline`을 쓴다.
 */
export function Loading({ size = 26 }: { size?: number }) {
  /** 호는 마크와 함께 커진다 — 고정 지름이면 큰 마크가 테두리에 닿는다 */
  const box = Math.round(size * 1.9);
  return (
    <span
      className="loading"
      role="status"
      aria-label="불러오는 중"
      style={{ width: box, height: box }}
    >
      <span className="loading-ring" aria-hidden />
      <span className="loading-mark">
        <IconMark size={size} />
      </span>
    </span>
  );
}

/**
 * 목록 한 칸이 오는 중 — **호 하나만.**
 *
 * 로고까지 세우면 목록 하나를 기다리는 일이 화면의 사건처럼 커진다. 여기서
 * 필요한 것은 "이 자리에 곧 뭐가 온다"는 표시뿐이라 글자 크기의 원 하나로 줄인다.
 */
export function LoadingInline() {
  return <span className="loading-inline" role="status" aria-label="불러오는 중" />;
}
