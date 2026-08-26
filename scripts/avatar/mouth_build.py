"""후보 환자 모델(Quaternius 계열)에 구강진찰용 입을 만든다.

- 얼굴 피부(Head 메시의 Skin 프리미티브)에 입술 바깥 타원 크기의 구멍을 내고(교차 삼각형 제거 + 경계 루프↔입술 바깥 링 재삼각화)
- 별도 메시(<Head>_Mouth, 같은 스킨)로 입술 링 · 구강 내벽 · 뒷벽(인두) · 위/아래 치열 · 혀 · 목젖을 넣는다.
- 닫힘(기본) ↔ 벌림은 glTF 모프 타깃 **MouthOpen** 하나로: 입술 안쪽 링이 슬릿→타원, 내부 조각은 슬릿 선에 접혀 있다가 펼쳐지고,
  피부의 턱(입선 아래 앞면)은 아래·뒤로 내려간다(턱 하강). 렌더러는 morphTargetInfluences['MouthOpen'] = 0..1 만 주면 된다.

좌표는 바인드 공간(z-up, 얼굴 앞 = −y). 치수는 cm 로 지정하고 units_per_m(머리 관절 높이 ≈ 0.87H, H≈1.75m 가정)로 환산.
"""
import math

from restyle_outfit import accessor


def _norm(v):
    L = math.sqrt(sum(c * c for c in v)) or 1.0
    return [c / L for c in v]


def _tri_normal(a, b, c):
    u = [b[i] - a[i] for i in range(3)]; w = [c[i] - a[i] for i in range(3)]
    return _norm([u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]])


def _smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


class MouthBuilder:
    def __init__(self, g, head_mesh, skin_mat='Skin', opts=None):
        self.g = g; self.o = dict(
            mouth_frac=0.42,      # 턱→코밑 사이 입 중심 위치
            width_frac=0.50,      # 입 반폭 = 얼굴 반폭 × 이 값
            lip=0.42,             # 입술 두께 cm
            open_up=0.4,          # 벌림: 안쪽 링 위쪽 반높이 cm(윗입술은 거의 고정)
            open_down=1.45,       # 벌림: 안쪽 링 아래쪽 반높이 cm(아랫입술이 턱과 내려감)
            closed_gap=0.07,      # 닫힘: 슬릿 반높이 cm
            depth=1.5,            # 구강 깊이 cm
            jaw_drop=1.2, jaw_back=0.35,  # 턱 하강 cm / 뒤로 cm
            segs=20,
        )
        self.o.update(opts or {})
        self.head_mesh = head_mesh; self.skin_mat = skin_mat
        hb = g.jpos['Head']; fb = g.jpos.get('Foot.L', g.jpos.get('Foot.R'))
        self.upm = math.dist(hb, fb) / (0.87 * 1.75)
        self.cm = 0.01 * self.upm
        self.hb = hb
        assert g.UP == 2 and g.DEP == 1 and g.LAT == 0, '이 도구는 z-up · 앞=−y 바인드 공간(Quaternius 계열)만 지원'

    # ── 피부 데이터 ──
    def load_skin(self):
        g = self.g
        mesh = g.mesh_by_name(self.head_mesh)
        self.mesh = mesh
        self.skin_p = next(p for p in mesh['primitives'] if g.js['materials'][p['material']].get('name') == self.skin_mat)
        p = self.skin_p
        self.attrs = {a: [list(r) if isinstance(r, (tuple, list)) else [r] for r in accessor(g.js, g.bin, ai)] for a, ai in p['attributes'].items()}
        self.meta = {a: g.js['accessors'][ai] for a, ai in p['attributes'].items()}
        self.idx = list(accessor(g.js, g.bin, p['indices']))
        self.tris = [self.idx[3 * t:3 * t + 3] for t in range(len(self.idx) // 3)]
        self.pos = self.attrs['POSITION']

    # ── 랜드마크 (cm, 머리 관절 기준: x 옆, f 앞(−y), z 위) ──
    def landmarks(self):
        hb, cm = self.hb, self.cm
        pos = self.pos; used = sorted(set(self.idx))
        X = lambda v: (v[0] - hb[0]) / cm; F = lambda v: -(v[1] - hb[1]) / cm; Z = lambda v: (v[2] - hb[2]) / cm
        mid = [(Z(pos[i]), F(pos[i])) for i in used if abs(X(pos[i])) < 0.6]
        face = [(z, f) for z, f in mid if f > 6]  # 얼굴 앞면(목·뒤통수 제외)
        nose_z, nose_f = max(face, key=lambda t: t[1])
        # 코밑: 코끝보다 아래(z 작음)이면서 앞쪽이 1.2cm 이상 꺼지는 첫 정점(코끝 바로 밑 링 포함), 없으면 코끝−1.2
        below = sorted([t for t in face if t[0] < nose_z and t[1] < nose_f - 1.2], key=lambda t: -t[0])
        nose_base_z = below[0][0] if below else nose_z - 1.2
        # 턱: 앞쪽이 코끝의 78% 이상인(턱 밑면·목 제외) 가장 낮은 앞면 정점
        chin_z = min(t[0] for t in face if t[1] > nose_f * 0.78 and t[0] < nose_base_z)
        mouth_z = chin_z + self.o['mouth_frac'] * (nose_base_z - chin_z)
        # 입 높이의 얼굴 반폭: 정면 정점(f > 코끝−4cm) 중 |z−mouth_z|<1.5 의 max |x|
        band = [abs(X(pos[i])) for i in used if F(pos[i]) > nose_f - 4 and abs(Z(pos[i]) - mouth_z) < 1.5]
        half_w = max(band) if band else 4.0
        self.L = dict(nose_z=nose_z, nose_f=nose_f, nose_base_z=nose_base_z, chin_z=chin_z, mouth_z=mouth_z, half_w=half_w,
                      a=half_w * self.o['width_frac'])
        return self.L

    # ── 표면 투영: (x_cm, z_cm) 에서 앞(−y)을 향한 직선과 피부의 앞쪽 교점 → (y_bind, normal) ──
    def surface(self, xc, zc):
        hb, cm, pos = self.hb, self.cm, self.pos
        x = hb[0] + xc * cm; z = hb[2] + zc * cm
        best = None
        for tri in self.tris:
            a, b, c = (pos[i] for i in tri)
            n = _tri_normal(a, b, c)
            if n[1] > -0.05:  # 앞을 보는 면만
                continue
            # 2D (x,z) 바리센트릭
            d = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])
            if abs(d) < 1e-18:
                continue
            w1 = ((b[0] - x) * (c[2] - z) - (c[0] - x) * (b[2] - z)) / d
            w2 = ((c[0] - x) * (a[2] - z) - (a[0] - x) * (c[2] - z)) / d
            w3 = 1 - w1 - w2
            if w1 < -1e-6 or w2 < -1e-6 or w3 < -1e-6:
                continue
            y = w1 * a[1] + w2 * b[1] + w3 * c[1]
            if best is None or y < best[0]:
                best = (y, n)
        if best is None:  # 표면 밖: 입 중심 깊이로 대체
            return self.center_y, [0, -1, 0]
        return best

    # ── 입 2D 형상(cm, 입 중심 기준 x, dz) ──
    def ring(self, a, up, down, k=1.0):
        """타원 링: 위 반높이 up, 아래 반높이 down(둘 다 cm). k 로 x 스케일. 각도 순(반시계, 오른쪽=0°)."""
        n = self.o['segs']; out = []
        for s in range(n):
            th = 2 * math.pi * s / n
            c, sn = math.cos(th), math.sin(th)
            h = up if sn >= 0 else down
            out.append((a * k * c, h * sn))
        return out

    # ── 본체 ──
    def build(self):
        g = self.g; o = self.o; cm = self.cm; hb = self.hb
        self.load_skin(); L = self.landmarks()
        a = L['a']; mz = L['mouth_z']
        self.center_y = self.surface_center()
        lip = o['lip']
        # 2D 링(닫힘/벌림) — z 는 입 중심 기준 상대(cm)
        inner_o = self.ring(a, o['open_up'], o['open_down'])
        inner_c = self.ring(a, o['closed_gap'], o['closed_gap'])
        outer_o = self.ring(a + lip, o['open_up'] + lip, o['open_down'] + lip)
        outer_c = self.ring(a + lip, o['closed_gap'] + lip, o['closed_gap'] + lip)
        # 벌림 상태의 아래쪽 링은 턱과 함께 내려가므로 y(깊이)·z 모두 턱 하강 포함 — outer_o 자체가 이미 아래로 길다.

        def jaw(zc):
            """입선 아래 z(cm, 머리 관절 기준)의 턱 하강 (dz_cm, dy_back_cm)"""
            if zc >= mz:
                return 0.0, 0.0
            t = _smooth((mz - zc) / max(1e-6, (mz - L['chin_z'])))
            return -o['jaw_drop'] * t, o['jaw_back'] * t

        # ── 1) 피부 구멍: 바깥 링(벌림) 타원과 교차하는 삼각형 제거 ──
        ax, up_o, dn_o = a + lip, o['open_up'] + lip, o['open_down'] + lip
        X = lambda v: (v[0] - hb[0]) / cm; Z = lambda v: (v[2] - hb[2]) / cm - mz; F = lambda v: -(v[1] - hb[1]) / cm

        def inside(xc, dz, scale=1.0):
            h = up_o if dz >= 0 else dn_o
            return (xc / (ax * scale)) ** 2 + (dz / (h * scale)) ** 2 <= 1.0

        def pt_in_tri(px, pz, t):
            a_, b_, c_ = ((X(self.pos[i]), Z(self.pos[i])) for i in t)
            d = (b_[0] - a_[0]) * (c_[1] - a_[1]) - (c_[0] - a_[0]) * (b_[1] - a_[1])
            if abs(d) < 1e-12:
                return False
            w1 = ((b_[0] - px) * (c_[1] - pz) - (c_[0] - px) * (b_[1] - pz)) / d
            w2 = ((c_[0] - px) * (a_[1] - pz) - (a_[0] - px) * (c_[1] - pz)) / d
            return w1 >= -1e-9 and w2 >= -1e-9 and (1 - w1 - w2) >= -1e-9

        samples = self.ring(ax, up_o, dn_o) + [(0.0, 0.0)]
        keep, removed = [], []
        for t in self.tris:
            vs = [self.pos[i] for i in t]
            front = all(F(v) > 4 for v in vs)
            hit = front and (any(inside(X(v), Z(v), 1.02) for v in vs) or any(pt_in_tri(px, pz, t) for px, pz in samples))
            (removed if hit else keep).append(t)
        assert removed, '입 영역과 교차하는 피부 삼각형이 없음'
        # 경계 루프: 제거 삼각형의 변 중 유지 삼각형과 공유되는 변(좌표 키)
        scale = max(abs(c) for v in self.pos for c in v)
        pk = lambda i: tuple(round(c / scale, 6) for c in self.pos[i])
        kept_edges = {}
        for t in keep:
            for u, v in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
                kept_edges.setdefault(frozenset((pk(u), pk(v))), []).append((u, v))
        boundary = {}  # 좌표키 → 대표 정점 인덱스(유지 삼각형 쪽)
        for t in removed:
            for u, v in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
                e = frozenset((pk(u), pk(v)))
                if e in kept_edges:
                    for ku, kv in kept_edges[e]:
                        boundary.setdefault(pk(ku), ku); boundary.setdefault(pk(kv), kv)
        assert len(boundary) >= 3, '경계 루프 없음'
        # 각도순 정렬(입 중심 기준)
        bl = sorted(boundary.values(), key=lambda i: math.atan2(Z(self.pos[i]), X(self.pos[i])))

        # ── 2) 새 정점 추가 유틸(피부 프리미티브) ──
        A = self.attrs
        nrm_skin = A['NORMAL']; uv_skin = A.get('TEXCOORD_0'); J = A['JOINTS_0']; W = A['WEIGHTS_0']
        head_j = g.jname.index('Head')

        def add_skin_vertex(p3, n3, like=None):
            A['POSITION'].append(list(p3)); nrm_skin.append(list(n3))
            if uv_skin is not None:
                uv_skin.append(list(uv_skin[like]) if like is not None else [0.5, 0.5])
            J.append(list(J[like]) if like is not None else [head_j, 0, 0, 0])
            W.append(list(W[like]) if like is not None else [1.0, 0.0, 0.0, 0.0])
            return len(A['POSITION']) - 1

        # 바깥 링(닫힘 상태 = 기본 형상)의 3D 점: 표면 투영 + 살짝 앞(0.05cm)
        def ring3d(ring2d, lift, follow_jaw=False, state_open=False):
            pts, nrms = [], []
            for xc, dz in ring2d:
                zc = mz + dz
                y, n = self.surface(xc, zc)
                p = [hb[0] + xc * cm, y - lift * cm, hb[2] + zc * cm]
                pts.append(p); nrms.append(n)
            return pts, nrms

        outer_c3, outer_n = ring3d(outer_c, 0.05)
        outer_o3, _ = ring3d(outer_o, 0.05)
        # 벌림 시 바깥 링 아래 절반의 턱 하강 반영(표면 투영은 닫힘 기준 피부라 y 는 jaw_back 만큼 뒤로)
        outer_o3 = [[p[0], p[1] + jaw(mz + dz)[1] * cm, p[2] + jaw(mz + dz)[0] * cm] if dz < 0 else p for p, (xc, dz) in zip(outer_o3, outer_o)]
        # 바깥 링 → 피부 정점(기본=닫힘) + 모프 델타(벌림−닫힘)
        ring_skin_idx = [add_skin_vertex(p, _norm([n[0] * 0.5 + on[0] * 0.5, n[1] * 0.5 + on[1] * 0.5, n[2] * 0.5 + on[2] * 0.5]))
                         for p, n, on in zip(outer_c3, outer_n, [[0, -1, 0]] * len(outer_n))]
        deltas = {}  # 피부 정점 → 모프 델타
        for i, pc, po in zip(ring_skin_idx, outer_c3, outer_o3):
            deltas[i] = [po[k] - pc[k] for k in range(3)]
        # 경계 루프 정점 복사(유지 삼각형 속성 그대로)
        bl_idx = [add_skin_vertex(self.pos[i], nrm_skin[i], like=i) for i in bl]
        # 브리지 삼각화: 두 루프를 각도순으로 병합
        ang_b = [math.atan2(Z(self.pos[i]), X(self.pos[i])) for i in bl]
        ang_r = [math.atan2(dz, xc) for xc, dz in outer_c]
        order_r = sorted(range(len(outer_c)), key=lambda k: ang_r[k])
        order_b = sorted(range(len(bl)), key=lambda k: ang_b[k])
        R = [ring_skin_idx[k] for k in order_r]; B = [bl_idx[k] for k in order_b]
        aR = [ang_r[k] for k in order_r]; aB = [ang_b[k] for k in order_b]
        new_tris = []
        i = j = 0; nB, nR = len(B), len(R)
        steps = 0
        while steps < nB + nR:
            # 다음 각도가 작은 쪽을 전진
            nb = aB[(i + 1) % nB] + (2 * math.pi if (i + 1) >= nB else 0)
            nr = aR[(j + 1) % nR] + (2 * math.pi if (j + 1) >= nR else 0)
            if (nb <= nr and i < nB) or j >= nR:
                new_tris.append([B[i % nB], R[j % nR], B[(i + 1) % nB]]); i += 1
            else:
                new_tris.append([R[j % nR], R[(j + 1) % nR], B[i % nB]]); j += 1
            steps += 1
        # 앞을 보도록 와인딩 정리
        P = A['POSITION']
        fixed = []
        for t in new_tris:
            n = _tri_normal(P[t[0]], P[t[1]], P[t[2]])
            fixed.append(t if n[1] <= 0 else [t[0], t[2], t[1]])
        self.tris = keep + fixed
        # 턱 하강 모프(피부): 입선 아래 앞면
        for i in range(len(P)):
            if i in deltas:
                continue
            v = P[i]; zc = (v[2] - hb[2]) / cm; f = F(v); xc = X(v)
            if zc < mz and f > 5 and zc > L['chin_z'] - 1.5 and abs(xc) < L['half_w'] + 1.5:
                dz, dy = jaw(zc)
                deltas[i] = [0.0, dy * cm, dz * cm]
        self.skin_deltas = [deltas.get(i, [0.0, 0.0, 0.0]) for i in range(len(P))]

        # ── 3) 입 메시 (닫힘=기본, 벌림=모프) ──
        M = dict(POSITION=[], NORMAL=[], TEXCOORD_0=[], JOINTS_0=[], WEIGHTS_0=[])
        Mo = []  # 벌림 위치
        prims = {}  # material → tri list

        def mv(pc, po, n):
            M['POSITION'].append(list(pc)); Mo.append(list(po)); M['NORMAL'].append(list(n)); M['TEXCOORD_0'].append([0.5, 0.5])
            M['JOINTS_0'].append([head_j, 0, 0, 0]); M['WEIGHTS_0'].append([1.0, 0.0, 0.0, 0.0])
            return len(M['POSITION']) - 1

        def tri(mat, t):
            prims.setdefault(mat, []).append(t)

        def quad(mat, a_, b_, c_, d_):
            tri(mat, [a_, b_, c_]); tri(mat, [a_, c_, d_])

        n = o['segs']
        front = [0.0, -1.0, 0.0]
        # 링 3D(닫힘/벌림): 안쪽 링은 표면 y − lift
        inner_c3, _ = ring3d(inner_c, 0.08); inner_o3, _ = ring3d(inner_o, 0.08)
        inner_o3 = [[p[0], p[1] + jaw(mz + dz)[1] * cm * 0.5, p[2]] for p, (xc, dz) in zip(inner_o3, inner_o)]
        # 입술 링: 바깥(피부와 같은 점, 앞 0.05) → 안쪽(앞 0.08, 위로 살짝 볼록)
        lip_out = [mv(pc, po, front) for pc, po in zip(outer_c3, outer_o3)]
        lip_mid_c = [[(pc[0] + ic[0]) / 2, (pc[1] + ic[1]) / 2 - 0.22 * cm, (pc[2] + ic[2]) / 2] for pc, ic in zip(outer_c3, inner_c3)]
        lip_mid_o = [[(po[0] + io[0]) / 2, (po[1] + io[1]) / 2 - 0.22 * cm, (po[2] + io[2]) / 2] for po, io in zip(outer_o3, inner_o3)]
        lip_mid = [mv(pc, po, front) for pc, po in zip(lip_mid_c, lip_mid_o)]
        lip_in = [mv(pc, po, front) for pc, po in zip(inner_c3, inner_o3)]
        for s in range(n):
            t = (s + 1) % n
            quad('Lips', lip_out[s], lip_mid[s], lip_mid[t], lip_out[t])
            quad('Lips', lip_mid[s], lip_in[s], lip_in[t], lip_mid[t])
        # 구강 내벽: 안쪽 링 → 뒤쪽 링(안쪽 링 × 0.8, depth 만큼 뒤). 닫힘 시 뒤쪽 링도 슬릿에 접힘
        D = o['depth'] * cm
        back_c3 = [[hb[0] + xc * 0.8 * cm, self.center_y + D, hb[2] + (mz + dz) * cm] for xc, dz in inner_c]
        back_o3 = [[hb[0] + xc * 0.8 * cm, self.center_y + D, hb[2] + (mz + dz * 0.8) * cm] for xc, dz in inner_o]
        wall_in = [mv(pc, po, [0, -1, 0]) for pc, po in zip(inner_c3, inner_o3)]
        wall_back = [mv(pc, po, [0, -1, 0]) for pc, po in zip(back_c3, back_o3)]
        for s in range(n):
            t = (s + 1) % n
            quad('MouthCavity', wall_in[t], wall_back[t], wall_back[s], wall_in[s])
        # 뒷벽(인두): 뒤쪽 링 팬
        cc = mv([hb[0], self.center_y + D + 0.2 * cm, hb[2] + mz * cm], [hb[0], self.center_y + D + 0.2 * cm, hb[2] + (mz - 0.5) * cm], front)
        for s in range(n):
            t = (s + 1) % n
            tri('Pharynx', [cc, wall_back[t], wall_back[s]])
        # 목젖: 뒷벽 위 중앙의 작은 물방울(벌림 시에만 크기)
        uz = mz + o['open_up'] * 0.15; ud = D - 0.15 * cm
        u_pts_o = [(0.0, uz + 0.1), (0.22, uz - 0.25), (0.0, uz - 0.7), (-0.22, uz - 0.25)]
        u_idx = [mv([hb[0], self.center_y + ud, hb[2] + mz * cm], [hb[0] + x * cm, self.center_y + ud, hb[2] + z * cm], front) for x, z in u_pts_o]
        quad('Uvula', u_idx[0], u_idx[1], u_idx[2], u_idx[3])
        # 치열: 안쪽 링의 위 호(15°~165°)·아래 호를 따라 내벽 바로 안쪽에 띠(개별 치아 8개, 사이 간격)
        def teeth(upper):
            teeth_n = 8; y0 = 0.35 * cm; h = 0.42 * cm
            for k in range(teeth_n):
                x0 = -a * 0.82 + (2 * a * 0.82) * k / teeth_n; x1 = x0 + (2 * a * 0.82) / teeth_n * 0.86
                for xx0, xx1 in ((x0, x1),):
                    # 호 위의 z: 타원 z = h_ring * sqrt(1 - (x/a)^2)
                    def zr(xc, up):
                        hh = (o['open_up'] if up else -o['open_down'])
                        return mz + hh * math.sqrt(max(0.0, 1 - (xc / a) ** 2)) * 0.92
                    zs0, zs1 = zr(xx0, upper), zr(xx1, upper)
                    sgn = -1 if upper else 1
                    pts_o = [[hb[0] + xx0 * cm, self.center_y + y0, hb[2] + zs0 * cm], [hb[0] + xx1 * cm, self.center_y + y0, hb[2] + zs1 * cm],
                             [hb[0] + xx1 * cm, self.center_y + y0, hb[2] + zs1 * cm + sgn * h], [hb[0] + xx0 * cm, self.center_y + y0, hb[2] + zs0 * cm + sgn * h]]
                    pts_c = [[p[0], self.center_y + y0, hb[2] + mz * cm] for p in pts_o]
                    q = [mv(pc, po, front) for pc, po in zip(pts_c, pts_o)]
                    if upper:
                        quad('Teeth', q[0], q[1], q[2], q[3])
                    else:
                        quad('Teeth', q[3], q[2], q[1], q[0])
        teeth(True); teeth(False)
        # 혀: 구강 바닥의 반타원 돔(벌림 시), 닫힘 시 슬릿에 접힘
        tz = mz - o['open_down'] * 0.55; ta = a * 0.62; tb = o['open_down'] * 0.5
        t_center = mv([hb[0], self.center_y + D * 0.5, hb[2] + mz * cm], [hb[0], self.center_y + D * 0.45, hb[2] + tz * cm], front)
        t_ring = []
        for s in range(n):
            th = 2 * math.pi * s / n; c_, s_ = math.cos(th), math.sin(th)
            po = [hb[0] + ta * c_ * cm, self.center_y + D * 0.7, hb[2] + (tz + tb * s_) * cm]
            pc = [po[0], self.center_y + D * 0.7, hb[2] + mz * cm]
            t_ring.append(mv(pc, po, front))
        for s in range(n):
            t = (s + 1) % n
            tri('Tongue', [t_center, t_ring[t], t_ring[s]])
        self.M = M; self.Mo = Mo; self.mouth_prims = prims
        return self

    def surface_center(self):
        self.center_y = None
        y, _ = self.surface(0.0, self.L['mouth_z'])
        self.center_y = y
        return y

    # ── GLB 에 쓰기 ──
    def write(self):
        g = self.g; A = self.attrs; p = self.skin_p; mesh = self.mesh
        # 피부 프리미티브 속성 재작성 + 인덱스 + 모프
        for a_, meta in self.meta.items():
            rows = A[a_]
            rows = [tuple(x) for x in rows] if meta['type'] != 'SCALAR' else [x[0] for x in rows]
            p['attributes'][a_] = g.add_accessor(rows, meta['componentType'], meta['type'], target=34962, normalized=meta.get('normalized', False))
        ctype = 5125 if len(A['POSITION']) > 65535 else 5123
        p['indices'] = g.add_indices([v for t in self.tris for v in t], ctype)
        p['targets'] = [{'POSITION': g.add_accessor([tuple(d) for d in self.skin_deltas], 5126, 'VEC3', target=34962)}]
        # 같은 메시의 다른 프리미티브: 0 델타 타깃(glTF: 프리미티브별 타깃 수 동일)
        for q in mesh['primitives']:
            if q is p:
                continue
            cnt = g.js['accessors'][q['attributes']['POSITION']]['count']
            q['targets'] = [{'POSITION': g.add_accessor([(0.0, 0.0, 0.0)] * cnt, 5126, 'VEC3', target=34962)}]
        mesh['weights'] = [0.0]
        mesh.setdefault('extras', {})['targetNames'] = ['MouthOpen']
        # 입 메시
        M = self.M
        acc = {
            'POSITION': g.add_accessor([tuple(x) for x in M['POSITION']], 5126, 'VEC3', target=34962),
            'NORMAL': g.add_accessor([tuple(x) for x in M['NORMAL']], 5126, 'VEC3', target=34962),
            'TEXCOORD_0': g.add_accessor([tuple(x) for x in M['TEXCOORD_0']], 5126, 'VEC2', target=34962),
            'JOINTS_0': g.add_accessor([tuple(x) for x in M['JOINTS_0']], 5123, 'VEC4', target=34962),
            'WEIGHTS_0': g.add_accessor([tuple(x) for x in M['WEIGHTS_0']], 5126, 'VEC4', target=34962),
        }
        delta = g.add_accessor([tuple(o_[k] - c_[k] for k in range(3)) for c_, o_ in zip(M['POSITION'], self.Mo)], 5126, 'VEC3', target=34962)
        COLORS = {'Lips': '#d4917b', 'MouthCavity': '#3a1114', 'Pharynx': '#5a1e24', 'Teeth': '#f1ece0', 'Tongue': '#cf5f78', 'Uvula': '#b7495d'}
        prims = []
        for mat, tris in self.mouth_prims.items():
            mi = g.material((mat, COLORS[mat]))
            m = g.js['materials'][mi]
            m['doubleSided'] = True
            prims.append({'attributes': dict(acc), 'indices': g.add_indices([v for t in tris for v in t], 5123), 'material': mi, 'mode': 4,
                          'targets': [{'POSITION': delta}]})
        mouth_mesh = {'name': self.head_mesh.replace('Head', 'Mouth'), 'primitives': prims, 'weights': [0.0], 'extras': {'targetNames': ['MouthOpen']}}
        g.js['meshes'].append(mouth_mesh)
        # 노드: 머리 노드와 같은 부모·스킨
        head_ni = next(i for i, nd in enumerate(g.nodes) if 'mesh' in nd and g.js['meshes'][nd['mesh']].get('name') == self.head_mesh)
        head_nd = g.nodes[head_ni]
        node = {'name': mouth_mesh['name'], 'mesh': len(g.js['meshes']) - 1}
        if 'skin' in head_nd:
            node['skin'] = head_nd['skin']
        g.nodes.append(node); ni = len(g.nodes) - 1
        parent = next((nd for nd in g.nodes if head_ni in nd.get('children', [])), None)
        if parent is not None:
            parent['children'].append(ni)
        else:
            g.js['scenes'][g.js.get('scene', 0)]['nodes'].append(ni)
        L = self.L
        print(f"  mouth [{self.head_mesh}]: 입 중심 z={L['mouth_z']:.2f}cm(턱 {L['chin_z']:.2f}·코밑 {L['nose_base_z']:.2f}) 반폭 {L['a']:.2f}cm, "
              f"피부 삼각형 {len(self.tris)}(브리지 포함), 입 정점 {len(M['POSITION'])}, 재질 {list(self.mouth_prims)} — 모프 MouthOpen")


def add_mouth(g, head_mesh, skin_mat='Skin', **opts):
    MouthBuilder(g, head_mesh, skin_mat, opts).build().write()
