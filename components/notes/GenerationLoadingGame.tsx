'use client';

/**
 * GenerationLoadingGame
 * ---------------------------------------------------------------------------
 * 문항 생성(최대 2분+) 대기 동안 보여주는 로딩 화면.
 *  - 최상단: 생성 진척 게이지 + "문제 생성까지 N% 완료" + "약 몇 분/몇 초 남았습니다"
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
 * 캐릭터는 메가맨 달리기 사이클을 레퍼런스로 한 3단계 스프라이트(질주→교차→질주)로
 * 애니메이션하고, 얼굴(머리·눈썹·눈·입)을 픽셀 단위로 모델링한다.
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

// ── 스프라이트 (12×19 셀, 셀당 4px → 48×76 논리 px, 기존 대비 2배) ──
const CELL = 4;
const SPRITE_W = 12;
const SPRITE_H = 19;
const CHAR_W = SPRITE_W * CELL; // 48
const CHAR_H = SPRITE_H * CELL; // 76

// ── 게임 상수 (논리 좌표, CSS px 기준) ──────────────────────────────
const LOGICAL_H = 272; // 캔버스 논리 높이
const GROUND_Y = LOGICAL_H - 30; // 지면 라인
const CHAR_X = 64;
const GRAVITY = 2000; // px/s^2
const JUMP_V0 = -760; // px/s (점프 최고 높이 ≈ 144px — 최대 장애물 54px 여유 통과)
const AIR_H = 28; // 날아오는 교재 높이 (1.5배)
const AIR_TOP = GROUND_Y - CHAR_H - AIR_H - 12; // 서 있으면 머리 위 12px 여유로 통과
const MAX_PLAY_SEC = 240; // 4분 맵: 난이도 스케일 상한

const SCENES = ['도서관', '복도', '캠퍼스'] as const;

// ── 캐릭터 스프라이트 정의 (메가맨 런 사이클 레퍼런스: 3단계) ──────
// 문자 → 팔레트: H머리 S피부 B눈썹 E흰자 P눈동자 M입 T상의 L하의 W신발 .투명
// 머리는 진행 방향(오른쪽)을 바라보는 대각선 측면(3/4) 뷰 —
// 뒤통수(왼쪽)는 머리카락, 얼굴은 앞쪽, 눈은 한쪽만 보인다(눈동자는 전방).
const HEAD_MALE = [
  '...HHHHHH...',
  '..HHHHHHHH..',
  '.HHHHHHHHHH.',
  '.HHHHHHHHHH.',
  '.HHHSSSSSSS.',
  '.HHSSBBBSSS.',
  '.HHSSEEPSSS.',
  '.HHSSSSSSSS.',
  '..SSSSMMMS..',
  '...SSSSSS...',
];
const HEAD_FEMALE = [
  '...HHHHHH...',
  '..HHHHHHHH..',
  '.HHHHHHHHHH.',
  'HHHHHHHHHHHH',
  'HHHHSSSSSSS.',
  'HHHSSBBBSSS.',
  'HHHSSEEPSSS.',
  'HHHSSSSSSSS.',
  'HHSSSSMMMS..',
  'HH.SSSSSS...',
];
// 몸통·팔·다리는 격자 프레임 교체가 아니라 관절 스켈레톤(어깨-팔꿈치-주먹 /
// 엉덩이-무릎-발목)을 사인 곡선으로 "연속" 구동해 그린다 — 레퍼런스 런 사이클처럼
// 긴 팔다리, 팔꿈치·무릎 굽힘, CONTACT→PASS→HIGH 사이의 자연스러운 중간 자세와
// 상하 바운스가 모두 나오고, 프레임 순간이동이 사라진다.
const HEADS: Record<Gender, string[]> = { male: HEAD_MALE, female: HEAD_FEMALE };
// 레퍼런스 얼굴(갈색 머리·살구 피부) 기반 팔레트
const PALETTE = (g: Gender): Record<string, string> => ({
  H: g === 'male' ? '#4a3120' : '#7a4a28',
  S: '#eebc93',
  B: '#3a2a1c',
  E: '#ffffff',
  P: '#26190f',
  M: '#a05a48',
  T: g === 'male' ? '#3f74c2' : '#d1567f',
  A: g === 'male' ? '#5f92dd' : '#e77fa2', // 앞쪽 팔(하이라이트) — 몸통보다 밝아 분리돼 보임
  D: g === 'male' ? '#26497e' : '#96375c', // 뒤쪽 팔(음영)
  L: '#3d4d68',
  K: '#181d26', // 뒤쪽 다리(음영)
  W: '#e8e8e8',
});
// 실루엣을 또렷하게 만드는 외곽선 색 (레퍼런스 픽셀아트의 다크 아웃라인).
const OUTLINE = '#221a12';

function formatEta(secs: number): string {
  const r = Math.max(10, Math.round(secs / 10) * 10);
  if (r >= 60) {
    const m = Math.floor(r / 60);
    const s = r % 60;
    return s > 0 ? `약 ${m}분 ${s}초 남았습니다` : `약 ${m}분 남았습니다`;
  }
  return `약 ${r}초 남았습니다`;
}

function GaugeBar({ progress, etaText }: { progress: number; etaText: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[12px] font-semibold text-sage-800 tracking-tight">
          문제 생성까지 {pct}% 완료했습니다
        </span>
        <span className="text-[12px] font-semibold text-sage-600 tabular-nums">{etaText}</span>
      </div>
      <div className="h-2.5 w-full rounded-full bg-[#e9e2d2] overflow-hidden">
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
  const [etaText, setEtaText] = useState('약 2분 남았습니다');

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioRef = useRef<AudioContext | null>(null);

  // ── 남은 시간 추정: 진행률 증가 속도 기반, 초기엔 기본 2분에서 카운트다운 ──
  const etaRef = useRef<{ start: number; p0: number }>({ start: 0, p0: 0 });
  useEffect(() => {
    etaRef.current = { start: performance.now(), p0: progress };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const tick = () => {
      const { start, p0 } = etaRef.current;
      const elapsed = (performance.now() - start) / 1000;
      // 보통 1분 내외로 끝난다 — 사용자에게 절대 "2분 초과"로 안내하지 않는다.
      // 남은 시간 = 기본 추정 2분에서 경과 시간만큼 감소(최소 10초 표시 유지).
      if (elapsed > 130) {
        setEtaText('곧 완료됩니다…');
        return;
      }
      const dp = progress - p0;
      let secs: number;
      if (elapsed > 8 && dp > 1.5) {
        secs = (100 - progress) * (elapsed / dp); // 실측 속도 기반
      } else {
        secs = 120 - elapsed;
      }
      // 상한 2분: 어떤 경우에도 그 이상으로 안내하지 않는다.
      secs = Math.min(120 - elapsed * 0.5, secs);
      setEtaText(formatEta(Math.min(120, Math.max(10, secs))));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [progress]);

  // 게임 상태는 리렌더를 피하려 ref 로 관리.
  const stateRef = useRef({
    charBottom: GROUND_Y,
    vy: 0,
    onGround: true,
    obstacles: [] as Obstacle[],
    elapsed: 0, // 초
    distSinceSpawn: 0,
    nextGap: 560,
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
  const beep = useCallback((type: 'jump' | 'hit') => {
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
  }, []);

  const resetGame = useCallback(() => {
    const s = stateRef.current;
    s.charBottom = GROUND_Y;
    s.vy = 0;
    s.onGround = true;
    s.obstacles = [];
    s.elapsed = 0;
    s.distSinceSpawn = 0;
    s.nextGap = 560;
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
    if (s.over || !s.started) {
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

    const pushGround = (s: typeof stateRef.current, x: number) => {
      const h = 34 + Math.floor(Math.random() * 20); // 책상/의자 높이 (1.5배)
      s.obstacles.push({
        x,
        w: 34 + Math.floor(Math.random() * 16),
        h,
        top: GROUND_Y - h,
        type: 'ground',
      });
    };

    const spawn = (s: typeof stateRef.current, w: number) => {
      const t = Math.min(MAX_PLAY_SEC, s.elapsed);
      // 공중 교재 빈도: 시간이 갈수록 잦아지되, 주기적 파동으로 몰렸다 뜸해졌다를 반복
      // (배치가 단조롭게 느껴지지 않도록).
      const wave = 0.5 + 0.5 * Math.sin(s.elapsed / 11);
      const pAir = s.elapsed > 12 ? Math.min(0.5, (t / MAX_PLAY_SEC) * 0.6 * (0.4 + wave)) : 0;
      const r = Math.random();
      if (r < pAir) {
        s.obstacles.push({ x: w + 10, w: 46, h: AIR_H, top: AIR_TOP, type: 'air' });
      } else if (s.elapsed > 35 && r < pAir + 0.2) {
        // 더블 의자 클러스터: 연속 점프를 요구 (35초 이후 등장)
        pushGround(s, w + 10);
        pushGround(s, w + 10 + 180 + Math.random() * 60);
      } else {
        pushGround(s, w + 10);
      }
      // 간격: 시간이 갈수록 평균 축소 + 큰 무작위 폭. 가끔(15%) 긴 휴식 구간을 넣어
      // 리듬에 완급을 준다.
      const base = Math.max(330, 660 - t * 3.2);
      const breather = Math.random() < 0.15 ? 320 + Math.random() * 260 : 0;
      s.nextGap = base + Math.random() * 260 + breather;
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
        // 달리기 사이클(회전) — 초당 약 1.4사이클(조깅), 속도 따라 소폭 증가.
        s.runPhase += dt * (s.speed / 170);
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
        const cx0 = CHAR_X + 6;
        const cx1 = CHAR_X + CHAR_W - 6;
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
    // fixed 오버레이가 아니라 페이지 콘텐츠로 렌더 — 상단 헤더/메뉴 바가 그대로 보여서
    // 대기 중에도 국시대비·내 문제집 등 다른 화면으로 자유롭게 이동할 수 있다.
    // (생성은 서버 큐에서 계속 진행되고, 완료 결과는 강의노트/내 문제집에서 확인 가능)
    <div className="flex flex-col min-h-[calc(100vh-160px)]">
      {/* 상단: 진척 게이지 + 남은 시간 */}
      <div className="px-4 pt-2 pb-3 sm:px-8">
        <div className="mx-auto w-full max-w-2xl">
          <GaugeBar progress={progress} etaText={etaText} />
          <p className="mt-2 text-[11px] text-[var(--color-muted)]">
            {fileName ? `‘${fileName}’ ` : ''}문항을 만드는 동안 잠깐 달려볼까요? — 생성이 끝나면 자동으로 문제가 열립니다.
          </p>
        </div>
      </div>

      {/* 게임 영역 */}
      <div className="flex-1 flex items-center justify-center px-3 pb-6 sm:px-8">
        <div className="w-full max-w-2xl">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-[var(--color-muted)] mr-1">캐릭터</span>
              {(['male', 'female'] as Gender[]).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGender(g)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                    gender === g
                      ? 'bg-sage-500 text-white'
                      : 'bg-black/5 text-sage-700 hover:bg-black/10'
                  }`}
                >
                  {g === 'male' ? '남자' : '여자'}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setMuted((m) => !m)}
              className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-black/5 text-sage-700 hover:bg-black/10"
            >
              {muted ? '🔇 음소거' : '🔊 소리'}
            </button>
          </div>

          <div
            className="relative w-full overflow-hidden rounded-2xl border border-[var(--color-border)] shadow-xl select-none cursor-pointer"
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

          <p className="mt-2 text-center text-[11px] text-[var(--color-muted)]">
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
    // 도서관: 채도를 낮춘 어두운 책장 — 밝은 원목색 장애물(책상·의자)이 또렷이 구분되게.
    ctx.fillStyle = '#221c15';
    ctx.fillRect(0, 0, w, GROUND_Y);
    const off = -(scroll * 0.4) % 90;
    for (let x = off; x < w + 90; x += 90) {
      ctx.fillStyle = '#332a20';
      ctx.fillRect(x, 40, 70, GROUND_Y - 40);
      // 책 스트라이프 (저채도 통일 톤)
      const colors = ['#4a4038', '#554a3e', '#403a32', '#4a4438', '#514438'];
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
      ctx.fillRect(x + 8, 100, 6, 6); // 손잡이
      ctx.fillRect(x + 34, 100, 6, 6);
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
      // 책상/의자 — 밝은 원목색 + 크림색 아웃라인으로 배경과 확실히 구분.
      ctx.fillStyle = '#f2e2c4';
      ctx.fillRect(o.x - 1, o.top - 1, o.w + 2, 8); // 상판 아웃라인
      ctx.fillStyle = '#c98a3f';
      ctx.fillRect(o.x, o.top, o.w, 7); // 상판
      ctx.fillStyle = '#a06a2c';
      ctx.fillRect(o.x + 3, o.top + 7, 6, o.h - 7); // 다리
      ctx.fillRect(o.x + o.w - 9, o.top + 7, 6, o.h - 7);
      ctx.fillStyle = '#b87a35';
      ctx.fillRect(o.x + o.w - 11, o.top - 18, 7, 18); // 의자 등받이
    } else {
      // 전공 교재 (공중, 표지+책배) — 선명한 빨간 표지.
      ctx.fillStyle = '#f2d9d2';
      ctx.fillRect(o.x - 1, o.top - 1, o.w + 2, o.h + 2); // 아웃라인
      ctx.fillStyle = '#c2413a';
      ctx.fillRect(o.x, o.top, o.w, o.h);
      ctx.fillStyle = '#e8d7a6';
      ctx.fillRect(o.x + o.w - 6, o.top, 6, o.h); // 책배(페이지)
      ctx.fillStyle = '#f2e6c0';
      ctx.fillRect(o.x + 6, o.top + 6, o.w - 18, 4); // 제목 띠
      ctx.fillRect(o.x + 6, o.top + 14, o.w - 20, 3);
    }
  }
}

function drawSprite(
  ctx: CanvasRenderingContext2D,
  rows: string[],
  x: number,
  top: number,
  pal: Record<string, string>,
  cell: number = CELL,
) {
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    for (let c = 0; c < row.length; c += 1) {
      const ch = row[c];
      if (ch === '.') continue;
      const color = pal[ch];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x + c * cell, top + r * cell, cell, cell);
    }
  }
}

// 2px 격자 스냅 — 회전하는 관절도 픽셀아트 질감을 유지한다.
const snap2 = (v: number) => Math.round(v / 2) * 2;

// 관절 마디(팔뚝·허벅지 등)를 외곽선 포함 픽셀 사각형 체인으로 그린다.
function limb(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  w: number,
  color: string,
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 2));
  for (const [ww, cc] of [
    [w + 3, OUTLINE],
    [w, color],
  ] as const) {
    ctx.fillStyle = cc as string;
    for (let i = 0; i <= steps; i += 1) {
      const x = snap2(x1 + (dx * i) / steps) - (ww as number) / 2;
      const y = snap2(y1 + (dy * i) / steps) - (ww as number) / 2;
      ctx.fillRect(x, y, ww as number, ww as number);
    }
  }
}

/**
 * 관절 스켈레톤 러너 — 레퍼런스 런 사이클을 관절 각도로 재현한다.
 *  - 다리: 허벅지 각도 = sin(θ) 스윙(앞뒤 ±49°), 무릎 굽힘은 다리가 앞으로
 *    돌아오는 회수 구간에서 최대(뒤꿈치가 엉덩이까지 접힘) → 착지 직전엔 거의 펴짐.
 *  - 팔: 다리와 반대 위상으로 스윙, 팔꿈치는 상시 ~90° 굽힘(주먹 앞).
 *  - 몸통: 진행 방향으로 기울고, 사이클당 2회 상하 바운스.
 */
function drawRunner(
  ctx: CanvasRenderingContext2D,
  s: { charBottom: number; onGround: boolean; runPhase: number },
  gender: Gender,
) {
  const pal = PALETTE(gender);
  const th = s.runPhase * Math.PI * 2;
  const onG = s.onGround;
  const g = s.charBottom;
  const bob = onG ? 2 * Math.cos(2 * th) : 0;
  const hipX = CHAR_X + 20;
  const hipY = g - 26 + bob;
  const shX = hipX + 5; // 어깨가 엉덩이보다 앞 → 전방 기울기
  const shY = hipY - 15;

  const leg = (off: number, color: string, tuckA?: number) => {
    // tuckA 지정 시 점프 자세(무릎 모음)
    const a = tuckA ?? 0.85 * Math.sin(th + off);
    const bend = tuckA != null ? 1.9 : 0.35 + 1.7 * Math.max(0, Math.cos(th + off));
    const kx = hipX + 13 * Math.sin(a);
    const ky = hipY + 13 * Math.cos(a);
    const sa = a - bend;
    const ax = kx + 12 * Math.sin(sa);
    const ay = ky + 12 * Math.cos(sa);
    limb(ctx, hipX, hipY, kx, ky, 7, color);
    limb(ctx, kx, ky, ax, ay, 6, color);
    // 신발(발끝 진행 방향)
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(snap2(ax) - 3, snap2(ay) - 3, 12, 7);
    ctx.fillStyle = pal.W;
    ctx.fillRect(snap2(ax) - 2, snap2(ay) - 2, 10, 5);
  };
  const arm = (off: number, color: string, raise = false) => {
    const aa = raise ? -1.1 : -0.95 * Math.sin(th + off); // 다리와 반대 위상, 큰 스윙
    const ex = shX + 10 * Math.sin(aa);
    const ey = shY + 1 + 10 * Math.cos(aa);
    const fa = aa + 1.5; // 팔꿈치 ~90° 굽힘, 전완은 앞으로
    const wx = ex + 9 * Math.sin(fa);
    const wy = ey + 9 * Math.cos(fa);
    limb(ctx, shX, shY + 1, ex, ey, 6, color);
    limb(ctx, ex, ey, wx, wy, 5, color);
    // 주먹
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(snap2(wx) - 3, snap2(wy) - 3, 8, 8);
    ctx.fillStyle = pal.S;
    ctx.fillRect(snap2(wx) - 2, snap2(wy) - 2, 6, 6);
  };

  // 그리기 순서: 뒷팔 → 뒷다리 → 몸통 → 앞다리 → 앞팔 → 머리
  // (뒤쪽 팔다리는 음영색 D/K 로 그려 몸통·앞쪽과 깊이가 분리돼 보인다)
  if (onG) {
    arm(Math.PI, pal.D);
    leg(Math.PI, pal.K);
  } else {
    arm(Math.PI, pal.D, true);
    leg(Math.PI, pal.K, -0.15);
  }
  limb(ctx, hipX, hipY, shX, shY, 14, pal.T); // 몸통(앞으로 기운 축)
  if (onG) {
    leg(0, pal.L);
    arm(0, pal.A);
  } else {
    leg(0, pal.L, 0.55);
    arm(0, pal.A, true);
  }
  // 머리(3/4 뷰 픽셀 스프라이트, 몸통보다 앞쪽)
  drawSprite(ctx, HEADS[gender], shX - 14, shY - 32, pal, 3);
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
