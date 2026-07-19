'use client';

/**
 * GenerationLoadingGame
 * ---------------------------------------------------------------------------
 * 문항 생성(최대 2분+) 대기 동안 보여주는 로딩 화면.
 *  - 최상단: 생성 진척 게이지 + "문제 생성까지 N% 완료했습니다" 메시지
 *  - 그 아래: 크롬 공룡게임 레퍼런스의 2D 픽셀 러너 미니게임
 *
 * 게임 규칙(사용자 확정):
 *  - 캐릭터는 CPX 환자(젊은 남/여, 평상복) 픽셀 스프라이트, 조작은 "점프"만.
 *  - 바닥 장애물(책상·의자) = 점프로 넘는다.
 *  - 공중 장애물(전공 교재, 머리 높이) = 점프하지 않고 서서 통과한다(잘못 점프하면 충돌).
 *  - 속도는 점점 빨라지고, 장애물 배치는 쉽게→어렵게. 배경(도서관→복도→캠퍼스)은 30초마다 순환.
 *  - 충돌 시 게임 오버 → "다시 도전하시겠습니까?".
 *  - 생성 완료 시 부모가 이 컴포넌트를 언마운트 → 즉시 문제 화면으로 전환.
 *
 * 외부 에셋/네트워크를 쓰지 않는다(모든 그래픽은 canvas 절차적 렌더, 사운드는 Web Audio).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type Gender = 'male' | 'female';

interface Obstacle {
  x: number;
  w: number;
  h: number;
  top: number;
  type: 'ground' | 'air';
}

// ── 게임 상수 (논리 좌표, CSS px 기준) ──────────────────────────────
const LOGICAL_H = 240; // 캔버스 논리 높이
const GROUND_Y = LOGICAL_H - 30; // 지면 라인
const CHAR_X = 56;
const CHAR_W = 22;
const CHAR_H = 38;
const GRAVITY = 2000; // px/s^2
const JUMP_V0 = -680; // px/s
const AIR_TOP = GROUND_Y - CHAR_H - 30; // 공중 장애물 상단(선 캐릭터 머리 위)
const AIR_H = 18;
const MAX_PLAY_SEC = 240; // 4분 맵: 난이도 스케일 상한

const SCENES = ['도서관', '복도', '캠퍼스'] as const;

function GaugeBar({ progress }: { progress: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[12px] font-semibold text-white/90 tracking-tight">
          문제 생성까지 {pct}% 완료했습니다
        </span>
        <span className="text-[11px] font-mono text-white/60 tabular-nums">{pct}%</span>
      </div>
      <div className="h-2.5 w-full rounded-full bg-white/15 overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-sage-300 to-sage-500 transition-[width] duration-500 ease-out"
          style={{ width: `${Math.max(4, pct)}%` }}
        />
      </div>
    </div>
  );
}

export default function GenerationLoadingGame({
  progress,
  fileName,
}: {
  progress: number;
  fileName?: string;
}) {
  const [gender, setGender] = useState<Gender>('male');
  const [muted, setMuted] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioRef = useRef<AudioContext | null>(null);

  // 게임 상태는 리렌더를 피하려 ref 로 관리.
  const stateRef = useRef({
    charBottom: GROUND_Y,
    vy: 0,
    onGround: true,
    obstacles: [] as Obstacle[],
    elapsed: 0, // 초
    distSinceSpawn: 0,
    nextGap: 520,
    speed: 240,
    runPhase: 0,
    scroll: 0,
    scoreAcc: 0,
    over: false,
    started: false,
  });
  const genderRef = useRef<Gender>('male');
  const mutedRef = useRef(false);
  useEffect(() => {
    genderRef.current = gender;
  }, [gender]);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  // ── 사운드 (Web Audio, 절차 생성) ───────────────────────────────
  const beep = useCallback(
    (type: 'jump' | 'hit') => {
      if (mutedRef.current) return;
      let ctx = audioRef.current;
      if (!ctx) {
        try {
          ctx = new (window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext })
              .webkitAudioContext)();
          audioRef.current = ctx;
        } catch {
          return;
        }
      }
      if (ctx.state === 'suspended') void ctx.resume();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      if (type === 'jump') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(720, now + 0.09);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        osc.start(now);
        osc.stop(now + 0.15);
      } else {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(320, now);
        osc.frequency.exponentialRampToValueAtTime(60, now + 0.35);
        gain.gain.setValueAtTime(0.16, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
        osc.start(now);
        osc.stop(now + 0.42);
      }
    },
    [],
  );

  const resetGame = useCallback(() => {
    const s = stateRef.current;
    s.charBottom = GROUND_Y;
    s.vy = 0;
    s.onGround = true;
    s.obstacles = [];
    s.elapsed = 0;
    s.distSinceSpawn = 0;
    s.nextGap = 520;
    s.speed = 240;
    s.runPhase = 0;
    s.scroll = 0;
    s.scoreAcc = 0;
    s.over = false;
    s.started = true;
    setScore(0);
    setGameOver(false);
  }, []);

  const jump = useCallback(() => {
    const s = stateRef.current;
    if (s.over) {
      resetGame();
      return;
    }
    if (!s.started) {
      resetGame();
      return;
    }
    if (s.onGround) {
      s.vy = JUMP_V0;
      s.onGround = false;
      beep('jump');
    }
  }, [beep, resetGame]);

  // ── 입력 ────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.key === ' ') {
        e.preventDefault();
        jump();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [jump]);

  // ── 게임 루프 ───────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let lastT: number | null = null;
    let width = 0;

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = parent.clientWidth;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(LOGICAL_H * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${LOGICAL_H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
    };
    resize();
    window.addEventListener('resize', resize);

    const spawn = (s: typeof stateRef.current, w: number) => {
      const pAir = Math.min(0.42, s.elapsed / 300);
      const isAir = s.elapsed > 12 && Math.random() < pAir;
      if (isAir) {
        s.obstacles.push({
          x: w + 10,
          w: 30,
          h: AIR_H,
          top: AIR_TOP,
          type: 'air',
        });
      } else {
        const h = 22 + Math.floor(Math.random() * 14); // 책상/의자 높이
        s.obstacles.push({
          x: w + 10,
          w: 22 + Math.floor(Math.random() * 12),
          h,
          top: GROUND_Y - h,
          type: 'ground',
        });
      }
      // 난이도: 시간이 지날수록 간격 축소 + 무작위.
      const t = Math.min(MAX_PLAY_SEC, s.elapsed);
      const base = Math.max(300, 560 - t * 3);
      s.nextGap = base + Math.random() * 190;
      s.distSinceSpawn = 0;
    };

    const loop = (t: number) => {
      rafRef.current = requestAnimationFrame(loop);
      if (lastT == null) lastT = t;
      let dt = (t - lastT) / 1000;
      lastT = t;
      if (dt > 0.05) dt = 0.05; // 탭 비활성 등으로 큰 점프 방지
      const s = stateRef.current;

      // ── 업데이트 ──
      if (s.started && !s.over) {
        s.elapsed += dt;
        const tt = Math.min(MAX_PLAY_SEC, s.elapsed);
        s.speed = Math.min(560, 240 + tt * 8); // 속도 점증(상한)
        s.runPhase += dt * (s.speed / 22);
        s.scroll += s.speed * dt;

        // 점프 물리
        if (!s.onGround) {
          s.vy += GRAVITY * dt;
          s.charBottom += s.vy * dt;
          if (s.charBottom >= GROUND_Y) {
            s.charBottom = GROUND_Y;
            s.vy = 0;
            s.onGround = true;
          }
        }

        // 스폰
        s.distSinceSpawn += s.speed * dt;
        if (s.distSinceSpawn >= s.nextGap) spawn(s, width);

        // 이동 + 충돌
        const charTop = s.charBottom - CHAR_H;
        const cx0 = CHAR_X + 3;
        const cx1 = CHAR_X + CHAR_W - 3;
        for (const o of s.obstacles) {
          o.x -= s.speed * dt;
          const ox0 = o.x + 2;
          const ox1 = o.x + o.w - 2;
          const oy0 = o.top;
          const oy1 = o.top + o.h;
          const overlapX = cx1 > ox0 && cx0 < ox1;
          const overlapY = s.charBottom > oy0 && charTop < oy1;
          if (overlapX && overlapY) {
            s.over = true;
            beep('hit');
            setGameOver(true);
            setBest((b) => {
              const finalScore = Math.floor(s.scoreAcc);
              return finalScore > b ? finalScore : b;
            });
          }
        }
        s.obstacles = s.obstacles.filter((o) => o.x + o.w > -20);

        // 점수
        s.scoreAcc += s.speed * dt * 0.03;
        if (Math.floor(s.scoreAcc) !== score) setScore(Math.floor(s.scoreAcc));
      }

      // ── 렌더 ──
      drawScene(ctx, width, s);
      drawObstacles(ctx, s.obstacles);
      drawRunner(ctx, s, genderRef.current);
      drawHud(ctx, width, s);

      if (!s.started) drawStartHint(ctx, width);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', resize);
    };
    // score 는 표시용 동기화라 loop 재생성 불필요 — 마운트당 1회 루프.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beep]);

  useEffect(() => {
    return () => {
      if (audioRef.current) void audioRef.current.close();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0f1720]">
      {/* 상단: 진척 게이지 */}
      <div className="px-4 pt-5 pb-3 sm:px-8">
        <div className="mx-auto w-full max-w-2xl">
          <GaugeBar progress={progress} />
          <p className="mt-2 text-[11px] text-white/45">
            {fileName ? `‘${fileName}’ ` : ''}문항을 만드는 동안 잠깐 달려볼까요? — 생성이 끝나면 자동으로 문제가 열립니다.
          </p>
        </div>
      </div>

      {/* 게임 영역 */}
      <div className="flex-1 flex items-center justify-center px-3 pb-6 sm:px-8">
        <div className="w-full max-w-2xl">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-white/50 mr-1">캐릭터</span>
              {(['male', 'female'] as Gender[]).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGender(g)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                    gender === g
                      ? 'bg-sage-500 text-white'
                      : 'bg-white/10 text-white/60 hover:bg-white/15'
                  }`}
                >
                  {g === 'male' ? '남자' : '여자'}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setMuted((m) => !m)}
              className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-white/10 text-white/70 hover:bg-white/15"
            >
              {muted ? '🔇 음소거' : '🔊 소리'}
            </button>
          </div>

          <div
            className="relative w-full overflow-hidden rounded-2xl border border-white/10 shadow-xl select-none cursor-pointer"
            onPointerDown={(e) => {
              e.preventDefault();
              jump();
            }}
            role="button"
            tabIndex={0}
            aria-label="점프 (스페이스 / 위 방향키 / 탭)"
          >
            <canvas ref={canvasRef} className="block w-full" style={{ imageRendering: 'pixelated' }} />

            {/* 게임 오버 오버레이 */}
            {gameOver && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/55 backdrop-blur-[1px]">
                <p className="text-white text-lg font-bold">게임 오버</p>
                <p className="text-white/70 text-sm">
                  점수 {score} · 최고 {best}
                </p>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    resetGame();
                  }}
                  className="mt-1 px-5 py-2 rounded-xl bg-sage-500 hover:bg-sage-400 text-white text-sm font-bold"
                >
                  다시 도전하시겠습니까?
                </button>
              </div>
            )}
          </div>

          <p className="mt-2 text-center text-[11px] text-white/40">
            스페이스 · 위 방향키 · 화면 탭으로 점프 — 책상·의자는 뛰어넘고, 머리 위로 날아오는 교재는 점프하지 말고 지나가세요.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── 렌더 헬퍼 (canvas 절차적 픽셀아트) ─────────────────────────────

function drawScene(
  ctx: CanvasRenderingContext2D,
  w: number,
  s: { elapsed: number; scroll: number },
) {
  const cur = Math.floor(s.elapsed / 30) % SCENES.length;
  const into = (s.elapsed % 30) / 30;
  // 30초 경계 근처 1초 크로스페이드
  const fadeStart = 29 / 30;
  drawSceneAt(ctx, w, cur, s.scroll);
  if (into > fadeStart) {
    const next = (cur + 1) % SCENES.length;
    const a = (into - fadeStart) / (1 - fadeStart);
    ctx.globalAlpha = a;
    drawSceneAt(ctx, w, next, s.scroll);
    ctx.globalAlpha = 1;
  }
  // 지면
  ctx.fillStyle = '#3a3226';
  ctx.fillRect(0, GROUND_Y, w, LOGICAL_H - GROUND_Y);
  ctx.fillStyle = '#4d422f';
  const off = -(s.scroll % 24);
  for (let x = off; x < w; x += 24) {
    ctx.fillRect(x, GROUND_Y, 12, 4);
  }
}

function drawSceneAt(ctx: CanvasRenderingContext2D, w: number, scene: number, scroll: number) {
  if (scene === 0) {
    // 도서관: 따뜻한 배경 + 책장
    ctx.fillStyle = '#2a2018';
    ctx.fillRect(0, 0, w, GROUND_Y);
    const off = -(scroll * 0.4) % 90;
    for (let x = off; x < w + 90; x += 90) {
      ctx.fillStyle = '#4a3826';
      ctx.fillRect(x, 40, 70, GROUND_Y - 40);
      // 책 스트라이프
      const colors = ['#b5533f', '#c99a3f', '#4f7a55', '#7a6ca8', '#c07a4f'];
      for (let sy = 48; sy < GROUND_Y - 8; sy += 22) {
        for (let bx = 0; bx < 64; bx += 8) {
          ctx.fillStyle = colors[(bx + sy) % colors.length];
          ctx.fillRect(x + 4 + bx, sy, 6, 18);
        }
      }
    }
  } else if (scene === 1) {
    // 복도: 시원한 배경 + 사물함/문
    ctx.fillStyle = '#1c2733';
    ctx.fillRect(0, 0, w, GROUND_Y);
    const off = -(scroll * 0.5) % 70;
    for (let x = off; x < w + 70; x += 70) {
      ctx.fillStyle = '#33475c';
      ctx.fillRect(x, 60, 52, GROUND_Y - 60);
      ctx.fillStyle = '#24323f';
      ctx.fillRect(x + 22, 60, 4, GROUND_Y - 60); // 사물함 분리선
      ctx.fillStyle = '#8fb0c9';
      ctx.fillRect(x + 8, 92, 6, 6); // 손잡이
      ctx.fillRect(x + 34, 92, 6, 6);
    }
    // 천장 조명
    const loff = -(scroll * 0.5) % 140;
    for (let x = loff; x < w + 140; x += 140) {
      ctx.fillStyle = '#c9d6e0';
      ctx.fillRect(x + 30, 14, 40, 6);
    }
  } else {
    // 캠퍼스 야외: 하늘 그라데이션 + 나무 + 건물 실루엣
    const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    g.addColorStop(0, '#6fa8c8');
    g.addColorStop(1, '#bfe0e6');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, GROUND_Y);
    // 건물
    const boff = -(scroll * 0.25) % 200;
    for (let x = boff; x < w + 200; x += 200) {
      ctx.fillStyle = '#7d8ba0';
      ctx.fillRect(x, 70, 120, GROUND_Y - 70);
      ctx.fillStyle = '#cfe3ea';
      for (let wy = 82; wy < GROUND_Y - 12; wy += 20) {
        for (let wx = 8; wx < 108; wx += 22) {
          ctx.fillRect(x + wx, wy, 12, 12);
        }
      }
    }
    // 나무
    const toff = -(scroll * 0.6) % 130;
    for (let x = toff; x < w + 130; x += 130) {
      ctx.fillStyle = '#5b3d24';
      ctx.fillRect(x + 24, GROUND_Y - 46, 8, 46);
      ctx.fillStyle = '#3f8a52';
      ctx.fillRect(x + 8, GROUND_Y - 74, 40, 34);
      ctx.fillStyle = '#4fa163';
      ctx.fillRect(x + 14, GROUND_Y - 66, 28, 18);
    }
  }
}

function drawObstacles(ctx: CanvasRenderingContext2D, obstacles: Obstacle[]) {
  for (const o of obstacles) {
    if (o.type === 'ground') {
      // 책상/의자 (갈색 픽셀 가구)
      ctx.fillStyle = '#8a5a2b';
      ctx.fillRect(o.x, o.top, o.w, 6); // 상판
      ctx.fillStyle = '#6b431f';
      ctx.fillRect(o.x + 2, o.top + 6, 4, o.h - 6); // 다리
      ctx.fillRect(o.x + o.w - 6, o.top + 6, 4, o.h - 6);
      ctx.fillStyle = '#7a4e26';
      ctx.fillRect(o.x + o.w - 8, o.top - 12, 5, 12); // 의자 등받이
    } else {
      // 전공 교재 (공중, 표지+책등)
      ctx.fillStyle = '#c2413a';
      ctx.fillRect(o.x, o.top, o.w, o.h);
      ctx.fillStyle = '#e8d7a6';
      ctx.fillRect(o.x + o.w - 4, o.top, 4, o.h); // 책배(페이지)
      ctx.fillStyle = '#f2e6c0';
      ctx.fillRect(o.x + 4, o.top + 4, o.w - 12, 3); // 제목 띠
      ctx.fillRect(o.x + 4, o.top + 10, o.w - 14, 2);
    }
  }
}

function drawRunner(
  ctx: CanvasRenderingContext2D,
  s: { charBottom: number; onGround: boolean; runPhase: number },
  gender: Gender,
) {
  const x = CHAR_X;
  const bottom = s.charBottom;
  const top = bottom - CHAR_H;
  const skin = '#f0c39a';
  const hair = gender === 'male' ? '#3a2a1c' : '#5a3a24';
  const shirt = gender === 'male' ? '#3f74c2' : '#d1567f';
  const pants = '#2f3a4a';

  // 머리
  ctx.fillStyle = skin;
  ctx.fillRect(x + 6, top, 10, 9);
  // 머리카락
  ctx.fillStyle = hair;
  ctx.fillRect(x + 5, top - 1, 12, 4);
  ctx.fillRect(x + 5, top, 2, 6);
  if (gender === 'female') {
    ctx.fillRect(x + 15, top, 3, 11); // 긴 머리
  } else {
    ctx.fillRect(x + 15, top, 2, 4);
  }
  // 몸통(티셔츠)
  ctx.fillStyle = shirt;
  ctx.fillRect(x + 4, top + 9, 14, 13);
  // 팔
  ctx.fillStyle = skin;
  const armSwing = Math.sin(s.runPhase) * 3;
  ctx.fillRect(x + 2, top + 11 + armSwing, 3, 8);
  ctx.fillRect(x + 17, top + 11 - armSwing, 3, 8);
  // 다리(달리기 2프레임 / 점프 시 모음)
  ctx.fillStyle = pants;
  if (s.onGround) {
    const phase = Math.floor(s.runPhase) % 2 === 0;
    if (phase) {
      ctx.fillRect(x + 5, top + 22, 4, 12);
      ctx.fillRect(x + 12, top + 22, 4, 9);
    } else {
      ctx.fillRect(x + 5, top + 22, 4, 9);
      ctx.fillRect(x + 12, top + 22, 4, 12);
    }
  } else {
    ctx.fillRect(x + 5, top + 22, 4, 10);
    ctx.fillRect(x + 13, top + 22, 4, 8);
  }
  // 신발
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(x + 5, top + CHAR_H - 3, 5, 3);
  ctx.fillRect(x + 12, top + CHAR_H - 3, 5, 3);
}

function drawHud(
  ctx: CanvasRenderingContext2D,
  w: number,
  s: { scoreAcc: number; elapsed: number },
) {
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = 'bold 12px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`${String(Math.floor(s.scoreAcc)).padStart(5, '0')}`, w - 10, 18);
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '10px ui-sans-serif, sans-serif';
  ctx.fillText(SCENES[Math.floor(s.elapsed / 30) % SCENES.length], 10, 18);
}

function drawStartHint(ctx: CanvasRenderingContext2D, w: number) {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, w, LOGICAL_H);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 15px ui-sans-serif, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('점프해서 시작 (스페이스 · 탭)', w / 2, LOGICAL_H / 2);
  ctx.textAlign = 'left';
}
