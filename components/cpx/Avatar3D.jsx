'use client'

// 환자 아바타 렌더러.
// public/models/ 에 GLB가 있으면 그것을 로드하고, 없으면 절차적 로우폴리로 폴백한다.
//   - /models/patient_{male|female}_old.glb  (60세 이상 케이스에서 최우선)
//   - /models/patient_{male|female}.glb      (성별 전용)
//   - /models/patient.glb                    (공용)
// 파일을 넣기만 하면 자동으로 3D 모델로 바뀐다. 라이선스는 docs/asset-license-ledger.md에 기록.
import { Canvas, createPortal, useFrame, useThree } from '@react-three/fiber'
import { useAnimations, useGLTF } from '@react-three/drei'
import { SkeletonUtils } from 'three-stdlib'
import * as THREE from 'three'

import { Component, Suspense, useEffect, useMemo, useRef, useState } from 'react'

// 파스텔 팔레트 (절차적 폴백용)
const SKIN = '#e8b89a'
const SKIN_F = '#f0c8ac'
const GOWN = '#cfe3d6'
const GOWN_F = '#dcebe0'
const HAIR_M = '#5b4636'
const HAIR_F = '#3f3128'

function lowPolyMat(color) {
  return <meshStandardMaterial color={color} flatShading roughness={0.85} metalness={0.05} />
}

// ── 진찰침대 + 눕기 좌표계 ───────────────────────────────────
// 눕기 회전 rotation.set(-π/2, 0, π/2)는 모델 좌표 (x,y,z)→월드 (-y, z, -x):
// 머리(+y)가 -x 방향, 얼굴(+z)이 +y(천장), 등(-z)이 침대에 닿는다.
const BED = { top: 0.5, length: 1.9, width: 0.75 }

// 신체진찰 부위 → 발끝 기준 신장 비율. 머리가 -x 쪽이므로 x = bodyH/2 - frac*bodyH.
// 모델 무관(정규화 신장 기반)이라 하드코딩 좌표 없음.
const EXAM_REGION_FRAC = {
  head: 0.93,
  neck: 0.84,
  chest: 0.7,
  abdomen: 0.55,
  pelvis: 0.45,
  legs: 0.25,
  knee: 0.27,
  foot: 0.06,
}

function ExamBed() {
  const { top: T, length: L, width: W } = BED
  const legH = T - 0.22
  return (
    <group>
      {/* 매트리스 */}
      <mesh position={[0, T - 0.06, 0]} castShadow receiveShadow>
        <boxGeometry args={[L, 0.12, W]} />
        {lowPolyMat(GOWN_F)}
      </mesh>
      {/* 프레임 */}
      <mesh position={[0, T - 0.17, 0]}>
        <boxGeometry args={[L + 0.08, 0.1, W + 0.06]} />
        {lowPolyMat('#8a9b90')}
      </mesh>
      {/* 다리 4개 */}
      {[
        [-L / 2 + 0.12, W / 2 - 0.1],
        [L / 2 - 0.12, W / 2 - 0.1],
        [-L / 2 + 0.12, -W / 2 + 0.1],
        [L / 2 - 0.12, -W / 2 + 0.1],
      ].map(([x, z], i) => (
        <mesh key={i} position={[x, legH / 2, z]}>
          <boxGeometry args={[0.08, legH, 0.08]} />
          {lowPolyMat('#7d8d84')}
        </mesh>
      ))}
      {/* 베개 — 머리 쪽(-x) */}
      <mesh position={[-L / 2 + 0.25, T + 0.04, 0]}>
        <boxGeometry args={[0.4, 0.09, W * 0.7]} />
        {lowPolyMat('#f4f8f4')}
      </mesh>
    </group>
  )
}

// 포즈/진찰 부위에 따라 카메라를 감쇠 이동. 기본 lying 뷰는 측면 전신,
// examTarget(누운 상태 한정)이 있으면 해당 부위 상방 클로즈업.
function CameraRig({ pose, examTarget, bodyH = 1.55 }) {
  const { camera } = useThree()
  const cur = useRef(null)
  useFrame((_, delta) => {
    const lying = pose === 'lying'
    const frac = lying && examTarget ? EXAM_REGION_FRAC[examTarget] : undefined
    let pos
    let tgt
    if (frac != null) {
      const x = bodyH / 2 - frac * bodyH
      pos = [x, BED.top + 1.25, 1.0]
      tgt = [x, BED.top + 0.1, 0]
    } else if (lying) {
      pos = [0, 1.45, 2.9]
      tgt = [0, BED.top, 0]
    } else {
      pos = [0, 1.35, 3.1]
      tgt = [0, 0.75, 0]
    }
    if (!cur.current) cur.current = { pos: new THREE.Vector3(...pos), tgt: new THREE.Vector3(...tgt) }
    const k = 1 - Math.exp(-3.5 * delta)
    cur.current.pos.lerp(new THREE.Vector3(...pos), k)
    cur.current.tgt.lerp(new THREE.Vector3(...tgt), k)
    camera.position.copy(cur.current.pos)
    camera.lookAt(cur.current.tgt)
  })
  return null
}

// 진찰 부위 스팟 조명 (눕기 + examTarget 활성 시)
function ExamSpotlight({ examTarget, bodyH = 1.55 }) {
  const light = useRef()
  const target = useMemo(() => new THREE.Object3D(), [])
  const frac = EXAM_REGION_FRAC[examTarget]
  useEffect(() => {
    if (light.current) light.current.target = target
  }, [target, frac])
  if (frac == null) return null
  const x = bodyH / 2 - frac * bodyH
  return (
    <>
      <spotLight ref={light} position={[x, BED.top + 1.7, 0.5]} angle={0.45} penumbra={0.7} intensity={2.5} />
      <primitive object={target} position={[x, BED.top + 0.1, 0]} />
    </>
  )
}

// ── GLB 머티리얼 색상 보정 ───────────────────────────────────
// 현재 GLB 4종 모두 Skin baseColorFactor가 [0.01,0.01,0.01](사실상 검정)로
// 저장된 변환 파이프라인 결함이 있어 런타임에 덮어쓴다.
// Face(눈·눈썹 지오메트리)는 원본이 흰색이라 피부톤 위에서 이목구비가
// 보이도록 어두운 색으로 교체. 상세: 아바타_3D모델_분석보고서 관점 1.
const GLB_COLOR_FIX = {
  Skin: SKIN, // 피부톤 (절차적 폴백과 동일 팔레트)
  Face: '#3a2a20', // 이목구비 — 어두운 갈색
}

function applyGlbColorFix(root) {
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return
    ;[].concat(o.material).forEach((m) => {
      const fix = m && GLB_COLOR_FIX[m.name]
      if (fix) m.color.set(fix)
    })
  })
}

// ── 주호소별 증상 모션 프로파일 ──────────────────────────────────
// 3D 모델은 LLM이 못 움직이므로, 케이스 category에 따라 절차적으로 몸짓을 얹는다.
// 필드: tremor(떨림 진폭) / hunch(앞으로 숙임 rad) / slump(축 처짐 rad) /
//       wobble(어지러운 흔들림) / fidget(안절부절 좌우) / cough(기침 반동 세기, 음성 연동) /
//       breath({rate,amp} 가쁜 호흡)
const MOTION_PROFILE_BY_CATEGORY = {
  '경련': { tremor: 0.020 },                 // 전신 발작성 떨림(강)
  '손떨림': { tremor: 0.006 },               // 미세 떨림
  '의식장애': { slump: 0.12, tremor: 0.003 },// 축 처지고 멍한 미동
  '발열': { slump: 0.05, tremor: 0.004 },    // 오한성 미세 떨림
  '급성 복통': { hunch: 0.17 },              // 배 움켜쥔 듯 상체 숙임(강)
  '소화불량/만성복통': { hunch: 0.10 },
  '구토': { hunch: 0.11 },
  '허리 통증': { hunch: 0.12 },
  '관절 통증': { hunch: 0.06 },
  '두통': { hunch: 0.05 },
  '가슴 통증': { hunch: 0.07 },
  '토혈': { hunch: 0.07 },
  '붉은색 소변': { hunch: 0.05 },
  '기침': { cough: 0.22 },                   // 기침 시 상체 반동(음성 연동)
  '객혈': { cough: 0.18 },
  '호흡곤란': { breath: { rate: 3.4, amp: 0.020 } }, // 가쁘고 큰 호흡
  '어지럼': { wobble: 0.05 },                // 좌우로 흔들림
  '불안': { fidget: 0.030 },                 // 안절부절 좌우 미동
  '기분 변화': { slump: 0.10 },
  '자살': { slump: 0.12 },
  '피로': { slump: 0.08 },
  '수면장애': { slump: 0.05 },
  '설사': { slump: 0.06 },
}

// 기저(호흡·idle) 변환이 매 프레임 절대값으로 세팅된 뒤, 그 위에 증상 몸짓을 가산한다.
function applySymptomMotion(g, p, t, { speaking, audioLevel, lying }) {
  if (!g || !p) return
  const lyingK = lying ? 0.4 : 1 // 누운 진찰 자세에서는 과한 몸짓을 줄여 프레이밍을 보존
  if (p.tremor) {
    const a = p.tremor * lyingK
    g.position.x += Math.sin(t * 47) * a
    g.position.y += Math.sin(t * 41 + 1.3) * a * 0.6
    g.rotation.z += Math.sin(t * 53) * a * 0.5
  }
  if (!lying && p.hunch) g.rotation.x += p.hunch + Math.sin(t * 1.2) * p.hunch * 0.15
  if (!lying && p.slump) { g.rotation.x += p.slump; g.position.y -= p.slump * 0.15 }
  if (!lying && p.wobble) { g.rotation.z += Math.sin(t * 1.7) * p.wobble; g.rotation.x += Math.sin(t * 1.1) * p.wobble * 0.7 }
  if (!lying && p.fidget) g.rotation.y += Math.sin(t * 3.2) * p.fidget
  if (p.cough && speaking) {
    // 큰 발화(기침음) 순간에 상체가 앞으로 툭 반동 — 음성 진폭에 비례
    const impulse = Math.max(0, audioLevel - 0.4) * p.cough * lyingK
    if (lying) g.position.x -= impulse * 0.5
    else { g.rotation.x += impulse; g.position.y -= impulse * 0.06 }
  }
  if (p.breath) {
    const b = Math.sin(t * p.breath.rate) * p.breath.amp
    g.scale.multiplyScalar(1 + b)
    if (!lying) g.position.y += Math.abs(b) * 0.4
  }
}

// ── 공용 애니메이션 훅: 호흡 + idle 흔들림 + 발화 반응 ──────────────
// hasIdleClip이면 모델 내장 Idle 애니메이션이 호흡을 담당하므로 스케일 호흡은 생략.
function useIdleMotion(ref, { speaking, audioLevel, pose, hasIdleClip = false, bodyH = 1.8, bodyMinZ = -0.2, motionProfile = null }) {
  const t = useRef(0)
  useFrame((_, delta) => {
    t.current += delta
    const g = ref.current
    if (!g) return
    const lying = pose === 'lying'
    const breathe = hasIdleClip ? 1 : 1 + Math.sin(t.current * 1.6) * 0.012
    const bob = speaking ? Math.sin(t.current * 8) * 0.012 * (0.4 + audioLevel) : 0
    g.scale.setScalar(breathe)
    if (lying) {
      // 등을 침대에 대고 천장 보기. (x,y,z)→(-y,z,-x): 머리 -x, 얼굴 +y.
      // y: 등(모델 -z 최저점)이 침대 상판에 닿도록 bodyMinZ(음수)만큼 들어올림.
      g.rotation.set(-Math.PI / 2, 0, Math.PI / 2)
      g.position.set(bodyH / 2, BED.top - bodyMinZ + bob, 0)
    } else {
      g.rotation.set(0, Math.sin(t.current * 0.5) * 0.05, 0)
      g.position.set(0, bob, 0)
    }
    applySymptomMotion(g, motionProfile, t.current, { speaking, audioLevel, lying })
  })
}

// ── A안: 얼굴 데칼 오버레이 (깜빡임 + 입 개폐) ─────────────────
// 현 GLB에 morph target·턱 본·입 지오메트리가 없어(분석보고서 관점 2)
// Head 본에 부착한 쿼드로 눈꺼풀·입을 표현한다. 앵커는 Face 프리미티브
// (눈·눈썹) 지오메트리에서 자동 산출 — 모델별 하드코딩 없음.
// 결정: 아바타_표현력_전략_결정자료.md §4 (A→B 단계론, 2026-07-09)

function computeFaceAnchors(root) {
  let face = null
  root.traverse((o) => {
    if (face || !(o.isMesh || o.isSkinnedMesh)) return
    if ([].concat(o.material).some((m) => m && m.name === 'Face')) face = o
  })
  const head = root.getObjectByName('Head')
  if (!face || !head || !face.geometry?.attributes?.position) return null

  // 모델 공간 → Head 본 로컬 변환 행렬. 오버레이 그룹에 이 행렬을 주면 자식은
  // 모델 공간 좌표(y위·z앞) 그대로 배치되고, 본에 부착돼 애니메이션을 따라간다.
  // 기준은 반드시 스키닝과 동일한 바인드 포즈(skeleton.boneInverses)여야 한다.
  // GLB 파일 저장 포즈(head.matrixWorld)는 바인드 포즈와 10.4° 어긋나 있어(4모델 공통)
  // 그 역행렬을 쓰면 오버레이가 얼굴 대비 약 5.7° 상시 기울어진다(입 삐뚤어짐 원인).
  root.updateMatrixWorld(true)
  const headIdx = face.isSkinnedMesh && face.skeleton ? face.skeleton.bones.indexOf(head) : -1
  const toHead = headIdx >= 0 ? face.skeleton.boneInverses[headIdx].clone() : head.matrixWorld.clone().invert()
  const pos = face.geometry.attributes.position
  const tmp = new THREE.Vector3()
  const pts = []
  for (let i = 0; i < pos.count; i++) pts.push(tmp.fromBufferAttribute(pos, i).applyMatrix4(face.matrixWorld).clone())

  // y 간격 기반 밴드 분리: [콧수염?] < 눈 < 눈썹 → 눈 = 위에서 두 번째 밴드
  const sorted = [...pts].sort((a, b) => a.y - b.y)
  const range = sorted[sorted.length - 1].y - sorted[0].y || 1
  const bands = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y - sorted[i - 1].y > range * 0.12) bands.push([])
    bands[bands.length - 1].push(sorted[i])
  }
  const eyes = bands.length >= 2 ? bands[bands.length - 2] : bands[0]

  const mean = (arr) => arr.reduce((m, p) => m.add(p), new THREE.Vector3()).divideScalar(arr.length || 1)
  const cx = mean([...eyes]).x
  const left = eyes.filter((p) => p.x < cx)
  const right = eyes.filter((p) => p.x >= cx)
  if (!left.length || !right.length) return null
  const eyeL = mean(left)
  const eyeR = mean(right)
  const eyeDist = eyeL.distanceTo(eyeR) || 0.1
  // 눈꺼풀 치수: 눈 클러스터 실측 (모델마다 눈 크기가 달라 eyeDist 비례는 과대/과소)
  const ext = (arr, axis) => {
    let lo = Infinity
    let hi = -Infinity
    arr.forEach((p) => {
      if (p[axis] < lo) lo = p[axis]
      if (p[axis] > hi) hi = p[axis]
    })
    return hi - lo
  }
  const eyeW = Math.max(ext(left, 'x'), ext(right, 'x'), eyeDist * 0.12) * 1.7
  const eyeH = Math.max(ext(eyes, 'y'), eyeDist * 0.1) * 3.0
  let frontZ = -Infinity
  pts.forEach((p) => {
    if (p.z > frontZ) frontZ = p.z
  })
  eyeL.z = frontZ + eyeDist * 0.04
  eyeR.z = frontZ + eyeDist * 0.04
  // 입 위치: Skin(얼굴 표면)·Hair(콧수염) 지오메트리 참조로 산출.
  // 콧수염이 있으면 그 아래로, z는 입 높이의 얼굴 최전방 + 여유(머리 회전 시 파묻힘 방지).
  const grab = (name) => {
    let mesh = null
    root.traverse((o) => {
      if (mesh || !(o.isMesh || o.isSkinnedMesh)) return
      if ([].concat(o.material).some((m) => m && m.name === name)) mesh = o
    })
    if (!mesh?.geometry?.attributes?.position) return []
    const p = mesh.geometry.attributes.position
    const out = []
    const v = new THREE.Vector3()
    for (let i = 0; i < p.count; i++) out.push(v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld).clone())
    return out
  }
  const eyeY = Math.min(eyeL.y, eyeR.y)
  const inFace = (p) =>
    p.z > 0 && Math.abs(p.x) < eyeDist * 0.7 && p.y < eyeY - eyeDist * 0.15 && p.y > eyeY - eyeDist * 2.4
  const skin = grab('Skin').filter(inFace)
  const beard = grab('Hair').filter(inFace) // male_old 콧수염 등 얼굴 전면의 헤어
  // 0.5: 바인드 포즈 기준 실측 보정값 (0.7은 턱 쪽으로 치우침 — 2026-07-10 피드백으로 상향. 1.0은 구 부착버그 흡수값)
  let mouthY = eyeY - eyeDist * 0.5
  if (beard.length) mouthY = Math.min(mouthY, Math.min(...beard.map((p) => p.y)) - eyeDist * 0.2)
  if (skin.length) mouthY = Math.max(mouthY, Math.min(...skin.map((p) => p.y)) + eyeDist * 0.3) // 턱 아래로 내려가지 않게
  let mouthZ = frontZ + eyeDist * 0.1
  // 콧수염(beard)도 z 산출에 포함 — 머리 회전 시 콧수염 날개가 입을 가리는 것 방지
  const band = skin.concat(beard).filter((p) => Math.abs(p.y - mouthY) < eyeDist * 0.35)
  if (band.length) mouthZ = Math.max(...band.map((p) => p.z)) + eyeDist * 0.1
  const mouth = new THREE.Vector3((eyeL.x + eyeR.x) / 2, mouthY, mouthZ)
  return { head, toHead, eyeL, eyeR, eyeDist, eyeW, eyeH, mouth }
}

function FaceOverlay({ anchors, speaking, audioLevel }) {
  const lidL = useRef()
  const lidR = useRef()
  const mouthRef = useRef()
  const st = useRef({ t: 0, next: 1.5 + Math.random() * 3, open: 0 })
  const { head, toHead, eyeL, eyeR, eyeDist, eyeW, eyeH, mouth } = anchors

  useFrame((state, delta) => {
    const s = st.current
    // 깜빡임: 2.5~5.5초 간격, 감기 100ms · 유지 60ms · 뜨기 140ms
    s.t += delta
    let closed = 0
    if (s.t >= s.next) {
      const e = s.t - s.next
      if (e < 0.1) closed = e / 0.1
      else if (e < 0.16) closed = 1
      else if (e < 0.3) closed = 1 - (e - 0.16) / 0.14
      else {
        s.t = 0
        s.next = 2.5 + Math.random() * 3
      }
    }
    ;[lidL, lidR].forEach((r) => {
      if (!r.current) return
      r.current.visible = closed > 0.05
      r.current.scale.y = Math.max(closed, 0.05)
    })
    // 입: 무음 시 얇은 선(다문 입 실루엣), 발화 시 볼륨 연동 개폐 (카툰식)
    const target = speaking ? (0.25 + 0.75 * audioLevel) * Math.abs(Math.sin(state.clock.elapsedTime * 11)) : 0
    s.open = THREE.MathUtils.lerp(s.open, target, 1 - Math.pow(0.001, delta))
    const m = mouthRef.current
    if (m) {
      m.scale.y = 0.16 + s.open * 0.95
      m.scale.x = 1 - s.open * 0.2
    }
  })

  const lidW = eyeW
  const lidH = eyeH
  return createPortal(
    <group matrix={toHead} matrixAutoUpdate={false}>
      <mesh ref={lidL} position={eyeL.toArray()} visible={false}>
        <planeGeometry args={[lidW, lidH]} />
        <meshStandardMaterial color={SKIN} flatShading roughness={0.85} />
      </mesh>
      <mesh ref={lidR} position={eyeR.toArray()} visible={false}>
        <planeGeometry args={[lidW, lidH]} />
        <meshStandardMaterial color={SKIN} flatShading roughness={0.85} />
      </mesh>
      <mesh ref={mouthRef} position={mouth.toArray()} scale={[1, 0.16, 1]}>
        <circleGeometry args={[eyeDist * 0.3, 16]} />
        <meshStandardMaterial color="#5f3a30" flatShading roughness={0.9} />
      </mesh>
    </group>,
    head
  )
}

// ── GLB 로더 ─────────────────────────────────────────────────
function GlbPatient({ url, ...motion }) {
  const { scene, animations } = useGLTF(url)
  // 스킨드 메시(리깅 모델)는 plain clone이 본 바인딩을 깨므로 SkeletonUtils로 복제
  const clone = useMemo(() => {
    const c = SkeletonUtils.clone(scene)
    applyGlbColorFix(c)
    return c
  }, [scene])
  // 어떤 드롭인 모델이든 키 ~1.55·발 y=0으로 정규화 (카메라 [0,1.4,3.2] 기준)
  // minZ: 등 쪽(-z) 최저점(스케일 적용) — 눕기 시 침대 접촉 높이 산출용.
  // Hair는 제외: 뒷머리 뭉치를 접촉 기준으로 삼으면 몸통이 침대에서 떠 보인다(머리카락은 눌린다고 가정).
  const { scale, offsetY, minZ } = useMemo(() => {
    const box = new THREE.Box3().setFromObject(clone)
    const h = box.max.y - box.min.y || 1
    const s = 1.55 / h
    const body = new THREE.Box3()
    clone.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return
      if ([].concat(o.material).some((m) => m && m.name === 'Hair')) return
      body.expandByObject(o)
    })
    const zRef = body.isEmpty() ? box.min.z : body.min.z
    return { scale: s, offsetY: -box.min.y * s, minZ: zRef * s }
  }, [clone])
  // A안 오버레이 앵커 (Face 지오메트리 기반 자동 산출; 실패 시 오버레이 생략)
  const anchors = useMemo(() => computeFaceAnchors(clone), [clone])
  const ref = useRef()
  const { mixer } = useAnimations(animations, ref)
  const hasIdleClip = useMemo(() => animations.some((a) => a.name === 'Idle'), [animations])
  // Idle 시작은 mixer에서 직접 한다. drei useAnimations의 actions는 첫 렌더 시점에 비어 있고,
  // 마운트 후 재렌더가 없으면(예: pose='lying'으로 직행 마운트) actions.Idle이 계속 undefined로 남아
  // Idle이 시작되지 않는 race가 있다 → 파일 저장 포즈(다리 굽힘)가 그대로 노출되던 버그(2026-07-10).
  useEffect(() => {
    if (!hasIdleClip || !ref.current) return
    if (new URLSearchParams(window.location.search).has('noanim')) return
    const clip = animations.find((a) => a.name === 'Idle')
    const action = mixer.clipAction(clip, ref.current)
    action.reset().fadeIn(0.3).play()
    return () => action.fadeOut(0.2)
  }, [animations, mixer, hasIdleClip])
  useIdleMotion(ref, { ...motion, hasIdleClip, bodyH: 1.55, bodyMinZ: minZ })
  return (
    <group ref={ref}>
      <group position={[0, offsetY, 0]} scale={scale}>
        <primitive object={clone} />
        {anchors && <FaceOverlay anchors={anchors} speaking={motion.speaking} audioLevel={motion.audioLevel} />}
      </group>
    </group>
  )
}

// ── 절차적 폴백 아바타 ────────────────────────────────────────
function ProceduralPatient({ gender, speaking, audioLevel, pose, motionProfile = null }) {
  const group = useRef()
  const head = useRef()
  const jaw = useRef()
  const t = useRef(0)
  const isMale = gender === '남성'
  const hair = isMale ? HAIR_M : HAIR_F
  const lying = pose === 'lying'

  useFrame((_, delta) => {
    t.current += delta
    const breathe = Math.sin(t.current * 1.6) * 0.015
    if (group.current) {
      group.current.scale.setScalar(1 + breathe)
      group.current.rotation.set(lying ? -Math.PI / 2 : 0, 0, lying ? Math.PI / 2 : 0)
      group.current.position.set(0, 0, 0)
      applySymptomMotion(group.current, motionProfile, t.current, { speaking, audioLevel, lying })
    }
    if (head.current) {
      head.current.rotation.y = Math.sin(t.current * 0.6) * 0.06
      head.current.rotation.x = speaking ? Math.sin(t.current * 8) * 0.03 * (0.4 + audioLevel) : Math.sin(t.current * 0.4) * 0.02
    }
    if (jaw.current) {
      const open = speaking ? (0.3 + audioLevel * 0.7) * Math.abs(Math.sin(t.current * 11)) : 0
      jaw.current.scale.y = 0.3 + open * 0.9
      jaw.current.position.y = 1.52 - open * 0.04
    }
  })

  return (
    <group
      ref={group}
      rotation={lying ? [-Math.PI / 2, 0, Math.PI / 2] : [0, 0, 0]}
      position={lying ? [0.9, BED.top + 0.42, 0] : [0, 0, 0]}
    >
      <mesh position={[0, 0.55, 0]} castShadow>
        <capsuleGeometry args={[0.42, 0.7, 4, 12]} />
        {lowPolyMat(GOWN)}
      </mesh>
      <mesh position={[0, 1.02, 0]}>
        <sphereGeometry args={[0.32, 12, 8]} />
        {lowPolyMat(GOWN_F)}
      </mesh>
      <mesh position={[-0.5, 0.6, 0]} rotation={[0, 0, 0.35]}>
        <capsuleGeometry args={[0.11, 0.6, 3, 8]} />
        {lowPolyMat(GOWN)}
      </mesh>
      <mesh position={[0.5, 0.6, 0]} rotation={[0, 0, -0.35]}>
        <capsuleGeometry args={[0.11, 0.6, 3, 8]} />
        {lowPolyMat(GOWN)}
      </mesh>
      <mesh position={[0, 1.28, 0]}>
        <cylinderGeometry args={[0.13, 0.16, 0.22, 10]} />
        {lowPolyMat(SKIN)}
      </mesh>
      <group ref={head} position={[0, 1.5, 0]}>
        <mesh castShadow>
          <sphereGeometry args={[0.3, 14, 12]} />
          {lowPolyMat(SKIN_F)}
        </mesh>
        <mesh position={[0, 0.08, -0.02]} scale={isMale ? [1.06, 0.7, 1.06] : [1.12, 0.95, 1.12]}>
          <sphereGeometry args={[0.3, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.62]} />
          {lowPolyMat(hair)}
        </mesh>
        <mesh position={[-0.11, 0.02, 0.26]}>
          <sphereGeometry args={[0.035, 8, 8]} />
          <meshStandardMaterial color="#2a2320" flatShading />
        </mesh>
        <mesh position={[0.11, 0.02, 0.26]}>
          <sphereGeometry args={[0.035, 8, 8]} />
          <meshStandardMaterial color="#2a2320" flatShading />
        </mesh>
        <mesh ref={jaw} position={[0, -0.14, 0.24]}>
          <boxGeometry args={[0.12, 0.05, 0.06]} />
          <meshStandardMaterial color="#b5695f" flatShading />
        </mesh>
      </group>
    </group>
  )
}

// GLB 로드 실패(파싱 오류 등) 시 절차적 아바타로 폴백하는 경계
class AvatarErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidUpdate(prev) {
    if (prev.url !== this.props.url && this.state.failed) this.setState({ failed: false })
  }
  render() {
    if (this.state.failed) return this.props.fallback
    return this.props.children
  }
}

const GENDER_KEY = { 남성: 'male', 여성: 'female' }

// public/models/ 에서 사용 가능한 GLB URL을 찾는다 (content-type으로 실존 확인).
// Vite dev는 없는 파일에 200+text/html(SPA 폴백)을 주므로 상태코드가 아닌 타입으로 판정.
function useResolvedModel(gender, age) {
  const [url, setUrl] = useState(undefined) // undefined=확인 중, null=없음, string=사용
  useEffect(() => {
    let alive = true
    const g = GENDER_KEY[gender] || 'male'
    const candidates = [
      ...(Number(age) >= 60 ? [`/cpx/models/patient_${g}_old.glb`] : []),
      `/cpx/models/patient_${g}.glb`,
    ]
    ;(async () => {
      for (const candidate of candidates) {
        try {
          const res = await fetch(candidate, { method: 'GET' })
          const type = res.headers.get('content-type') || ''
          if (res.ok && !type.includes('text/html')) {
            if (alive) setUrl(candidate)
            return
          }
        } catch {
          /* 다음 후보 */
        }
      }
      if (alive) setUrl(null)
    })()
    return () => {
      alive = false
    }
  }, [gender, age])
  return url
}

function PatientAvatar({ gender, age, speaking, audioLevel, pose, motionProfile }) {
  const url = useResolvedModel(gender, age)
  const procedural = <ProceduralPatient gender={gender} speaking={speaking} audioLevel={audioLevel} pose={pose} motionProfile={motionProfile} />

  // 확인 중이거나 GLB 없음 → 절차적
  if (!url) return procedural

  return (
    <AvatarErrorBoundary url={url} fallback={procedural}>
      <Suspense fallback={procedural}>
        <GlbPatient url={url} speaking={speaking} audioLevel={audioLevel} pose={pose} motionProfile={motionProfile} />
      </Suspense>
    </AvatarErrorBoundary>
  )
}

// examTarget: 누운 상태가 필수인 신체진찰 시 카메라·조명이 향할 부위 키 (EXAM_REGION_FRAC 참조)
export default function Avatar3D({ gender = '남성', age, speaking = false, audioLevel = 0, pose = 'sitting', examTarget = null, category = '' }) {
  const motionProfile = MOTION_PROFILE_BY_CATEGORY[category] || null
  return (
    <Canvas
      key={`${gender}-${age}`}
      shadows="percentage"
      camera={{ position: [0, 1.35, 3.1], fov: 40 }}
      onCreated={({ camera }) => camera.lookAt(0, 0.75, 0)}
      dpr={[1, 2]}
    >
      <ambientLight intensity={0.55} />
      <directionalLight position={[3, 4, 3]} intensity={1.5} color="#ffe8bf" castShadow />
      <directionalLight position={[-3, 2, -2]} intensity={0.6} color="#bcd6ff" />
      <pointLight position={[0, 2, -3]} intensity={1.2} color="#f3c64e" />
      <CameraRig pose={pose} examTarget={examTarget} />
      {pose === 'lying' && <ExamBed />}
      {pose === 'lying' && examTarget && <ExamSpotlight examTarget={examTarget} />}
      <PatientAvatar gender={gender} age={age} speaking={speaking} audioLevel={audioLevel} pose={pose} motionProfile={motionProfile} />
      {typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debugaxes') && (
        <axesHelper args={[1.5]} />
      )}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.15, 0]} receiveShadow>
        <circleGeometry args={[2, 32]} />
        <shadowMaterial opacity={0.15} />
      </mesh>
    </Canvas>
  )
}
