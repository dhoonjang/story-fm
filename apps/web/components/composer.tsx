"use client";

import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { IconDay, IconMatch, IconPlay, IconSend, IconSkip, IconWeek } from "./icons";

/**
 * 시간을 넘기는 손잡이 — **버튼이 곧 감독의 말**이다.
 *
 * 엔진을 직접 부르지 않고 채팅으로 도는 이유는 `game-screen.tsx`의 `send`에 적어
 * 두었다. 문장은 **감독의 말투가 아니라 조작의 이름**이다 — 이건 `operator`
 * 채널로 가고 모델에는 `<operator>시간 진행 — 하루</operator>`로 들어간다. "하루만 넘기자"
 * 같은 구어체로 두면 이력에 감독이 한 말처럼 남는다.
 *
 * 눈금을 셋으로 끊은 건 프리시즌 때문이다 — 7월엔 다음 경기가 몇 주 뒤라
 * "다음 경기로"만 있으면 이적·훈련을 들여다볼 틈 없이 개막까지 날아간다.
 *
 * ⚠️ 아래 `say` 문장은 **서버가 되읽는다** (`parseTimeSkip` — gm-types.ts).
 * 손잡이로 넘긴 시간만은 모델을 거치지 않고 코어가 먼저 굴리기 때문이다.
 * 문구를 바꾸면 그 파서도 함께 고쳐야 한다 — 안 그러면 조작이 감독의 발화로
 * 읽혀 시계가 모델의 헤더에 다시 매달린다 (agents 테스트가 문장을 고정한다).
 */
const TIME_SKIPS = [
  { key: "day", label: "하루", say: () => "시간 진행 — 하루" },
  { key: "week", label: "일주일", say: () => "시간 진행 — 일주일" },
  {
    key: "match",
    label: "다음 경기",
    /**
     * **날짜를 붙여 보낸다.** 시간은 GM이 첫 줄 헤더에 적은 시점으로 흐르므로
     * (`applyScenePoint`), 목표가 "다음 경기"라는 말뿐이면 모델이 일정을 조회해
     * 날짜를 옮겨 적어야 한다 — 한 번 더 왕복하고 틀릴 여지도 생긴다.
     * 클라이언트는 그 날짜를 이미 알고 있다(달력 뷰의 `isNext`).
     */
    say: (date: string) => `시간 진행 — 다음 경기 (${date})`,
  },
] as const;

/** 시간 손잡이의 얼굴 — 해(하루) · 달력 한 줄(일주일) · 공(다음 경기) */
const SKIP_ICONS = { day: IconDay, week: IconWeek, match: IconMatch } as const;

/**
 * 입력줄 — **손잡이는 하나고 뜻은 상황이 정한다.**
 *
 * 채팅 아래 붙는 한 덩어리다. 무대의 나머지(`game-screen.tsx`)는 이 안을 모른다 —
 * 넘기는 것은 지금 쓰고 있는 글과 그것을 보내는 길뿐이다.
 */
export function Composer({
  input,
  onInput,
  onSend,
  busy,
  inMatch,
  canSkip,
  nextMatchDate,
  inputRef,
}: {
  input: string;
  onInput: (value: string) => void;
  /** 턴을 보낸다 — `operator`면 감독의 발화가 아니라 조작으로 나간다 */
  onSend: (text?: string, operator?: boolean) => void;
  busy: boolean;
  inMatch: boolean;
  /** 시간을 넘길 수 있는가 — 경기 중에는 시간을 경기가 민다 */
  canSkip: boolean;
  /** 다음 경기 날짜 — 없으면(시즌 끝) "다음 경기" 눈금을 그리지 않는다 */
  nextMatchDate: string | null;
  /**
   * 답이 끝난 뒤 커서를 되돌려 주는 자리 — 무대가 쥔다 (`game-screen.tsx`).
   * 포커스는 턴이 끝나는 시점의 일이라 입력줄 혼자 알 수 없다.
   */
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  /** 시간 손잡이의 선택지가 펼쳐져 있는가 — 입력이 비었을 때만 열 수 있다 */
  const [skipOpen, setSkipOpen] = useState(false);
  /** 쓸 말이 있으면 보내기, 없으면 시간 손잡이 — 버튼 하나가 두 뜻을 갖는다 */
  const hasInput = input.trim().length > 0;

  // 입력 textarea 높이 자동 조절 — 내용이 늘면 최대 높이까지 커지고 이후 스크롤
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input, inputRef]);

  /**
   * 시간 이동 — **자주 하는 지시라 손이 아니라 눈에 둔다.**
   *
   * 매번 "다음 경기로 가자"를 타이핑하게 두면 GM이 대신 "시간을 보내시겠습니까?"
   * 하고 되묻는 장면으로 턴을 닫는다. 그건 감독이 결정할 일을 세계가 대신
   * 물어보는 것이라, 넘기는 손잡이를 감독 쪽에 두고 GM에겐 되묻지 못하게 했다.
   *
   * 다만 **늘 펼쳐 두지는 않는다.** 칩 세 개가 입력창 위에 상주하면 감독이
   * 할 일이 "말하기"인지 "넘기기"인지 화면이 두 갈래로 말한다. 입력이 비어
   * 있을 때만 같은 버튼이 시간 손잡이가 되고, 한 글자라도 쓰면 보내기가 된다 —
   * **손잡이는 하나고 뜻은 상황이 정한다.**
   *
   * 경기 중에는 숨긴다 — 그때 시간은 경기가 밀고, 진행은 채팅이 맡는다.
   */
  return (
    <div className="composer">
      {skipOpen && canSkip && (
        <>
          {/* 바깥을 눌러 닫는다 — 메뉴 밖 어디든 */}
          <button
            className="skip-scrim"
            type="button"
            aria-label="닫기"
            onClick={() => setSkipOpen(false)}
          />
          <div className="skip-menu" data-testid="time-skip" role="menu">
            {TIME_SKIPS.map((t) => {
              // 남은 경기가 없으면(시즌 끝) 갈 곳이 없다 — 그리지 않는다
              if (t.key === "match" && !nextMatchDate) return null;
              const say = t.say(nextMatchDate ?? "");
              const Icon = SKIP_ICONS[t.key];
              return (
                <button
                  key={t.key}
                  role="menuitem"
                  onClick={() => {
                    setSkipOpen(false);
                    onSend(say, true);
                  }}
                  disabled={busy}
                  data-testid={`skip-${t.key}`}
                >
                  <Icon />
                  {t.label}
                </button>
              );
            })}
          </div>
        </>
      )}
      <div className="chat-input">
        <textarea
          ref={inputRef}
          value={input}
          rows={1}
          onChange={(e) => {
            onInput(e.target.value);
            // 쓰기 시작하면 버튼이 보내기로 바뀐다 — 열려 있던 선택지는 닫는다
            if (e.target.value.trim()) setSkipOpen(false);
          }}
          onKeyDown={(e) => {
            // Enter = 전송, Shift+Enter = 줄바꿈 (IME 조합 중에는 무시)
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
          disabled={busy}
          data-testid="chat-input"
        />
        {/**
         * **손잡이는 하나다.** 쓸 말이 없으면 시간 손잡이, 한 글자라도 쓰면 보내기.
         *
         * 경기 중에는 시간 손잡이 자리가 **진행**이 된다 — 그때 시간을 미는 건
         * 달력이 아니라 경기이고, 감독이 할 일도 "계속"이라고 타이핑하는 게
         * 아니라 한 구간 더 굴리는 것이다.
         *
         * 아이콘만 두는 건 입력칸 **안에** 앉기 때문이다 — 글자를 얹으면 쓸 폭을
         * 뺏는다. 무엇을 하는 손잡이인지는 **아이콘이 바뀌는 것**이 말하고, 화면
         * 밖의 이름은 `aria-label`이 갖는다 — 단축키를 글로 알리지 않는다.
         */}
        <button
          className={hasInput ? "send" : inMatch ? "send" : "skip"}
          onClick={() => {
            if (hasInput) return void onSend();
            if (inMatch) return void onSend("계속", true);
            setSkipOpen((v) => !v);
          }}
          disabled={busy || (!hasInput && !inMatch && !canSkip)}
          data-testid={hasInput ? "chat-send" : inMatch ? "match-advance" : "time-skip-toggle"}
          aria-label={hasInput ? "전송" : inMatch ? "경기 진행" : "시간 보내기"}
          aria-expanded={hasInput || inMatch ? undefined : skipOpen}
        >
          {hasInput ? <IconSend /> : inMatch ? <IconPlay /> : <IconSkip />}
        </button>
      </div>
    </div>
  );
}
