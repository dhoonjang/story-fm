/**
 * 아이콘 — **선 하나 굵기의 단색 SVG.**
 *
 * 예전에는 탭에 이모지(👥 📅 💰)를 썼다. 이모지는 플랫폼마다 모양·색·크기가 달라
 * 나란히 놓으면 줄이 맞지 않고, 화면의 색 팔레트를 무시한다. 여기 아이콘은
 * `currentColor`를 따르므로 선택 상태·비활성 상태가 글자와 같은 규칙으로 변한다.
 *
 * 24 그리드에 stroke 1.7 — 12~20px 어디에 놓아도 획 굵기가 같아 보인다.
 */

export type IconProps = { size?: number };

/**
 * 아이콘 하나 — 표에 담아 자리별로 고르는 자리에서 쓴다.
 *
 * 크기 인자를 지운 `() => ReactElement`로 적으면 **실제 아이콘이 하나도 들어가지
 * 않는다** — 인자를 받는 함수는 인자 없는 함수 자리에 서지 못한다.
 */
export type IconComponent = (props: IconProps) => React.ReactElement;

/**
 * **면 아이콘** — 채워진 실루엣. 입력창의 초록 버튼처럼 색면 위에 앉거나 작게
 * 쓰이는 자리에서는 선보다 면이 또렷하다(1.7px 획은 16px에서 흐려진다).
 * 안쪽을 파낼 땐 `fillRule="evenodd"` — 뚫린 곳으로 바탕이 비쳐 두 번째 색이 된다.
 *
 * ⚠️ 모든 도형은 **(12,12)에 정확히 중심을 둔다.** 아이콘 옆에 글자가 서면 1px만
 * 치우쳐도 줄이 안 맞아 보인다 (달력 아이콘이 아래로 1px 처져 있었다).
 */
const solid = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "currentColor",
  "aria-hidden": true,
});

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

/**
 * 로고 마크 — **말풍선이면서 공.**
 *
 * 이 게임의 한 줄은 "말이 축구가 된다"이다. 그래서 마크도 둘을 겹친다 — 둥근
 * 몸통은 공(가운데 오각형 한 조각)이고, 왼쪽 아래로 꼬리가 나와 말풍선이 된다.
 * 22px에서도 읽히도록 안쪽은 오각형 **하나만** 둔다(솔기까지 그리면 뭉개진다).
 */
export function IconMark({ size = 22 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden
    >
      {/* 꼬리 — 몸통과 겹쳐 두면 채움이 하나로 붙는다 */}
      <path d="M7.9 17 3.6 21.9 10.5 19.6z" />
      {/* 몸통(원) + 오각형 — `evenodd`로 오각형이 뚫린다. 선으로 그리면 22px에서
          획이 뭉개지므로 **면**으로 그린다 */}
      <path
        fillRule="evenodd"
        d="M12 2.6a8.9 8.9 0 1 0 0 17.8 8.9 8.9 0 0 0 0-17.8zM12 6.4 16.76 9.85 14.94 15.45H9.06L7.24 9.85z"
      />
    </svg>
  );
}

/** 채팅 — 말풍선. 여기가 홈이다 */
export function IconChat({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M20 15a3 3 0 0 1-3 3H8l-4 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z" />
    </svg>
  );
}

/** 스쿼드 — 사람 둘 */
export function IconSquad({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.6a3.2 3.2 0 0 1 0 6.3" />
      <path d="M17.5 14.6a5.5 5.5 0 0 1 3 4.9" />
    </svg>
  );
}

/** 달력 */
export function IconCalendar({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}

/** 재정 — 오르내리는 선 (돈은 곧 흐름이다) */
export function IconFinance({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3.5 17.5 9 11l4 3.5 7.5-8" />
      <path d="M20.5 6.5h-4.2M20.5 6.5v4.2" />
      <path d="M3.5 20.5h17" />
    </svg>
  );
}

/** 대회 — 트로피 */
export function IconTrophy({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M7 4h10v5a5 5 0 0 1-10 0z" />
      <path d="M7 5.5H4.5V7a3 3 0 0 0 3 3M17 5.5h2.5V7a3 3 0 0 1-3 3" />
      <path d="M12 14v3.5M8.5 20.5h7" />
    </svg>
  );
}

/** 커리어 — 메달 */
export function IconCareer({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="15" r="5.2" />
      <path d="M9 10.2 7 3.5h10l-2 6.7" />
      <path d="m12 12.8 1 2 2.2.3-1.6 1.5.4 2.2-2-1-2 1 .4-2.2-1.6-1.5 2.2-.3z" />
    </svg>
  );
}

/** 닫기 */
/**
 * 보내기 — **위로 향한 화살표.** 종이비행기는 24 그리드에서 획이 서로 만나
 * 작은 크기(16~18px)에서 뭉개진다. 화살표는 어느 크기에서도 방향이 남는다.
 */
/**
 * 보내기 — **선 아이콘.** 채운 화살표는 같은 초록 버튼 위에서 덩어리가 너무 커
 * 버튼이 아니라 화살표가 먼저 보였다. 획으로 그리면 색면과 기호가 층을 나눈다.
 * (옆자리 빨리감기는 삼각형이라 선으로 그리면 속이 빈 채 흔들려 면 그대로 둔다)
 */
export function IconSend({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2.2}>
      <path d="M12 20V4.6" />
      <path d="M5.4 11.2 12 4.6l6.6 6.6" />
    </svg>
  );
}

/**
 * 시간 보내기 — **빨리감기.** 시계는 "지금 몇 시"로 읽히고, 이 버튼이 하는 일은
 * 시간을 **앞으로 미는** 것이다. 두 삼각형이 그 뜻을 크기와 무관하게 남긴다.
 */
export function IconSkip({ size = 18 }: IconProps) {
  return (
    <svg {...solid(size)}>
      {/**
       * 빨리감기 — **광학 중심**으로 맞춘다. 삼각형은 무게가 밑변(왼쪽)에 쏠려
       * 있어서, 도형의 양 끝을 3.5~20.5로 두면 좌우 여백은 같은데 **눈에는 왼쪽으로
       * 붙어 보인다**(오른쪽이 비어 보인다). 무게중심이 12에 오도록 오른쪽으로
       * 1.4만큼 민다 — 그래서 이 도형은 일부러 좌우 여백이 다르다.
       */}
      <path d="M4.9 5.5 12.9 12l-8 6.5v-13ZM13.7 5.5 21.7 12l-8 6.5v-13Z" />
    </svg>
  );
}

/** 하루 — 해. 하루의 단위는 해가 뜨고 지는 것이다 */
export function IconDay({ size = 16 }: IconProps) {
  return (
    <svg {...solid(size)}>
      {/* 해 — 가운데 원과 여덟 갈래. 모두 (12,12) 중심 회전이라 어느 쪽도 안 치우친다 */}
      <circle cx="12" cy="12" r="4.6" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
        <rect
          key={deg}
          x="11"
          y="1.8"
          width="2"
          height="3.6"
          rx="1"
          transform={`rotate(${deg} 12 12)`}
        />
      ))}
    </svg>
  );
}

/** 일주일 — 달력의 한 줄. 주는 달력에서 **가로 한 줄**로 산다 */
export function IconWeek({ size = 16 }: IconProps) {
  return (
    <svg {...solid(size)}>
      {/**
       * 달력에서 파낸 **가로 한 줄** — 주는 달력에서 그렇게 산다.
       * 몸통 y는 4~20.4라 고리(2.6~6)까지 합치면 세로 중심이 정확히 12다.
       */}
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8 2.6a1 1 0 0 1 1 1V4.6h6V3.6a1 1 0 1 1 2 0v1h.9A2.6 2.6 0 0 1 20.5 7.2v10.6a2.6 2.6 0 0 1-2.6 2.6H6.1a2.6 2.6 0 0 1-2.6-2.6V7.2a2.6 2.6 0 0 1 2.6-2.6H7V3.6a1 1 0 0 1 1-1ZM6.6 12.3h10.8v2.4H6.6v-2.4Z"
      />
    </svg>
  );
}

/** 다음 경기 — 공. 이 게임에서 다음 마디를 여는 건 언제나 경기다 */
export function IconMatch({ size = 16 }: IconProps) {
  return (
    <svg {...solid(size)}>
      {/* 공 — 채운 원에서 오각형을 파낸다. 둘 다 (12,12) 중심 */}
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2.8a9.2 9.2 0 1 1 0 18.4 9.2 9.2 0 0 1 0-18.4Zm0 4.9-4.05 2.94 1.55 4.76h5l1.55-4.76L12 7.7Z"
      />
    </svg>
  );
}

export function IconClose({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** 새로 만들기 — 더하기 */
export function IconPlus({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** DB — 데이터베이스 실린더. 카탈로그 편집이 다루는 게 "표"라는 걸 그린다 */
export function IconDatabase({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6" />
      <path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3" />
    </svg>
  );
}

/** 세이브 삭제 — 휴지통. ✕는 "닫기"로도 읽혀 지운다는 뜻이 흐렸다 */
export function IconTrash({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 7h16M10 4h4M6 7l1 13h10l1-13" />
      <path d="M10.5 11v5.5M13.5 11v5.5" />
    </svg>
  );
}

/**
 * 수석코치 — **클립보드.**
 *
 * 훈련장에서 코치를 가리키는 물건이다. 휘슬도 후보였지만 18px에서 몸통과 노즐이
 * 붙어 콩 하나로 뭉갠다. 안쪽 두 줄은 "적어 둔 것"이라 채우지 않는다.
 */
export function IconCoach({ size = 15 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M8.6 4.4H5.6A1.6 1.6 0 0 0 4 6v13.4A1.6 1.6 0 0 0 5.6 21h12.8a1.6 1.6 0 0 0 1.6-1.6V6a1.6 1.6 0 0 0-1.6-1.6h-3" />
      <path d="M9.4 2.6h5.2a.8.8 0 0 1 .8.8v2.8H8.6V3.4a.8.8 0 0 1 .8-.8z" />
      <path d="M7.6 12h8.8M7.6 16.2h5.6" />
    </svg>
  );
}

/**
 * 주장 — **완장.** 축구에서 이 자리를 가리키는 유일한 표식이라 설명이 필요 없다.
 * 안쪽 호는 C — 완장에 실제로 적히는 글자다.
 */
export function IconCaptain({ size = 15 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="4.4" y="4" width="15.2" height="16" rx="2.8" />
      <path d="M15.1 8.4a4.6 4.6 0 1 0 0 7.2" />
    </svg>
  );
}

/** 중계 — 마이크. 무대 밖에서 들어오는 목소리다 */
export function IconBroadcast({ size = 15 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="9.2" y="2.8" width="5.6" height="10.4" rx="2.8" />
      <path d="M6 11.4a6 6 0 0 0 12 0M12 17.4V21M9.4 21h5.2" />
    </svg>
  );
}

/**
 * 선수 — **유니폼.** 소매가 벌어진 저지 실루엣이라 사람 아이콘과 15px에서도 갈린다.
 * 등번호는 넣지 않는다 — 그 자리에 숫자를 그리면 두 획이 뭉쳐 얼룩이 된다.
 */
export function IconJersey({ size = 15 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M9 3.2 4.2 5.6a1 1 0 0 0-.5 1.2l1.2 3.6a1 1 0 0 0 1.2.7l1.3-.4v8.7a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1v-8.7l1.3.4a1 1 0 0 0 1.2-.7l1.2-3.6a1 1 0 0 0-.5-1.2L15 3.2" />
      <path d="M9 3.2a3 3 0 0 0 6 0" />
    </svg>
  );
}

/**
 * 자리를 모르는 화자 — **사람.** 기자·에이전트·남의 팀 사람처럼 세이브가 이름을
 * 모르는 화자에 선다. 틀린 직책을 다느니 "누군가 말한다"까지만 말한다.
 */
export function IconPerson({ size = 15 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20.4a7 7 0 0 1 14 0" />
    </svg>
  );
}

/**
 * 기자 — **마이크.** 회견장에서 감독 앞으로 내밀어지는 그것이다.
 *
 * 수첩·카메라도 후보였지만 수첩은 코치의 클립보드와 한눈에 헷갈리고(둘 다 사각형에
 * 줄), 카메라는 방송만 가리킨다. 마이크는 **질문받는 자리**를 뜻하므로 지역지든
 * 타블로이드든 같은 표식으로 선다 — 어느 매체인지는 이름 옆 직책이 말한다.
 */
export function IconReporter({ size = 15 }: IconProps) {
  return (
    <svg {...base(size)}>
      {/* 마이크 헤드 — 손에 쥐는 그 모양 */}
      <rect x="9.4" y="2.6" width="5.2" height="9.6" rx="2.6" />
      {/* 집음부의 결 — 두 줄이면 그물망으로 읽힌다 */}
      <path d="M9.4 6.2h5.2M9.4 9h5.2" />
      {/* 손잡이와 받침 — 회견 탁자에 선 마이크 */}
      <path d="M12 15.6v5.2M9 20.8h6" />
      {/* 집음 범위 — 마이크가 향한 쪽을 감싼다 */}
      <path d="M6.6 11.4a5.4 5.4 0 0 0 10.8 0" />
    </svg>
  );
}

/**
 * 구단주 — **넥타이.** 감독을 고용한 사람이고, 감독실 밖에서 오는 유일한 목소리다.
 * 왕관·돈다발도 후보였지만 하나는 과장이고 하나는 인물을 희화한다.
 */
export function IconOwner({ size = 15 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M9 3h6l-1.4 3.4h-3.2z" />
      <path d="M12 6.4 10 13.6a2 2 0 0 0 .5 1.9l1.5 1.6 1.5-1.6a2 2 0 0 0 .5-1.9z" />
      <path d="M7.6 4.2 5.2 6.2M16.4 4.2l2.4 2" />
    </svg>
  );
}

/** 접기·펼치기 — 아래 꺾쇠. 펼쳐지면 CSS가 뒤집는다 */
export function IconChevron({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="m6 9.5 6 6 6-6" />
    </svg>
  );
}

/** 키포인트 — 돋보기. 판을 들여다보고 찾아낸 것들 */
export function IconInsight({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="10.5" cy="10.5" r="6.3" />
      <path d="m15.2 15.2 4.4 4.4" />
      <path d="M8 10.5h5M10.5 8v5" />
    </svg>
  );
}

/** 전술판 — 그라운드와 배치된 점 */
export function IconBoard({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3.2" y="4.5" width="17.6" height="15" rx="1.8" />
      <path d="M12 4.5v15" />
      <circle cx="12" cy="12" r="2.2" />
    </svg>
  );
}

/** 경기 진행 — 재생. 한 구간을 더 굴린다 */
export function IconPlay({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M8 5.5v13l10.5-6.5z" />
    </svg>
  );
}
