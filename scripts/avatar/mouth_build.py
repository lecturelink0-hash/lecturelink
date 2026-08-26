"""후보 환자 모델(Quaternius 계열)에 볼륨 있는 입술을 조형한다.

- 얼굴 정중선 프로파일로 코밑·턱을 계측해 입 위치·폭을 잡고,
- 윗입술(큐피드 활 있는 상단 경계)·아랫입술(더 도톰)을 **얼굴 표면 위로 부풀어 오른 곡면 그리드**로 만들어
  별도 메시(<Head>_Mouth, 같은 스킨·Head 본)에 넣는다. 각 정점은 (x, z)에서 피부를 레이캐스트한 표면점 + 법선 × 두께.
  법선은 그리드에서 스무스하게 계산해 저폴리에서도 둥근 입술로 보인다.
- 입술 사이에는 살짝 들어간 얇은 입선(MouthLine)만 둔다. 벌림·구강 내부·모프는 없다(2026-08-26 피드백: 평면 덧붙임은 부자연,
  두툼한 입술 볼륨만 살릴 것).

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


class LipsBuilder:
    def __init__(self, g, head_mesh, skin_mat='Skin', opts=None):
        self.g = g
        self.o = dict(
            mouth_frac=0.42,   # 턱→코밑 사이 입 중심 위치
            width_frac=0.50,   # 입 반폭 = 얼굴 반폭 × 이 값
            h_up=0.50,         # 윗입술 높이(입선→상단 경계, 중앙 기준) cm
            h_low=0.62,        # 아랫입술 높이 cm
            d_up=0.17,         # 윗입술 최대 두께(표면에서 앞으로) cm — 얇게(2026-08-26 피드백)
            d_low=0.22,        # 아랫입술 최대 두께 cm
            line_d=0.06,       # 입선에서 두 입술이 만나는 높이 cm
            corner_dip=0.12,   # 입꼬리가 입선 중앙보다 내려가는 양 cm
            cols=6, rows=2,    # 로우폴리: 입술당 6×2 쿼드, 쿼드마다 플랫 법선(큰 네모 면)
        )
        self.o.update(opts or {})
        self.head_mesh = head_mesh; self.skin_mat = skin_mat
        hb = g.jpos['Head']; fb = g.jpos.get('Foot.L', g.jpos.get('Foot.R'))
        self.upm = math.dist(hb, fb) / (0.87 * 1.75)
        self.cm = 0.01 * self.upm
        self.hb = hb
        assert g.UP == 2 and g.DEP == 1 and g.LAT == 0, '이 도구는 z-up · 앞=−y 바인드 공간(Quaternius 계열)만 지원'

    # ── 피부 ──
    def load_skin(self):
        g = self.g
        mesh = g.mesh_by_name(self.head_mesh)
        self.mesh = mesh
        p = next(p for p in mesh['primitives'] if g.js['materials'][p['material']].get('name') == self.skin_mat)
        self.pos = accessor(g.js, g.bin, p['attributes']['POSITION'])
        idx = accessor(g.js, g.bin, p['indices'])
        self.idx = idx
        self.tris = [idx[3 * t:3 * t + 3] for t in range(len(idx) // 3)]

    # ── 랜드마크 (cm, 머리 관절 기준: x 옆, f 앞(−y), z 위) ──
    def landmarks(self):
        hb, cm, pos = self.hb, self.cm, self.pos
        used = sorted(set(self.idx))
        X = lambda v: (v[0] - hb[0]) / cm; F = lambda v: -(v[1] - hb[1]) / cm; Z = lambda v: (v[2] - hb[2]) / cm
        mid = [(Z(pos[i]), F(pos[i])) for i in used if abs(X(pos[i])) < 0.6]
        face = [(z, f) for z, f in mid if f > 6]
        nose_z, nose_f = max(face, key=lambda t: t[1])
        below = sorted([t for t in face if t[0] < nose_z and t[1] < nose_f - 1.2], key=lambda t: -t[0])
        nose_base_z = below[0][0] if below else nose_z - 1.2
        chin_z = min(t[0] for t in face if t[1] > nose_f * 0.78 and t[0] < nose_base_z)
        mouth_z = chin_z + self.o['mouth_frac'] * (nose_base_z - chin_z)
        band = [abs(X(pos[i])) for i in used if F(pos[i]) > nose_f - 4 and abs(Z(pos[i]) - mouth_z) < 1.5]
        half_w = max(band) if band else 4.0
        self.L = dict(nose_z=nose_z, nose_f=nose_f, nose_base_z=nose_base_z, chin_z=chin_z, mouth_z=mouth_z, half_w=half_w,
                      a=half_w * self.o['width_frac'])
        return self.L

    # ── 표면 투영: (x_cm, z_cm) 에서 앞(−y) 방향 직선과 피부의 앞쪽 교점 → (점, 법선) ──
    def surface(self, xc, zc):
        hb, cm, pos = self.hb, self.cm, self.pos
        x = hb[0] + xc * cm; z = hb[2] + zc * cm
        best = None
        for tri in self.tris:
            a, b, c = (pos[i] for i in tri)
            n = _tri_normal(a, b, c)
            if n[1] > -0.05:
                continue
            d = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])
            if abs(d) < 1e-18:
                continue
            w1 = ((b[0] - x) * (c[2] - z) - (c[0] - x) * (b[2] - z)) / d
            w2 = ((c[0] - x) * (a[2] - z) - (a[0] - x) * (c[2] - z)) / d
            w3 = 1 - w1 - w2
            if w1 < -1e-6 or w2 < -1e-6 or w3 < -1e-6:
                continue
            y = w1 * a[1] + w2 * b[1] + w3 * c[1]
            if best is None or y < best[0][1]:
                best = ([x, y, z], n)
        if best is None:
            return [x, self.center_y, z], [0.0, -1.0, 0.0]
        return best

    # ── 입술 곡면 ──
    def build(self):
        o = self.o; cm = self.cm
        self.load_skin(); L = self.landmarks()
        a = L['a']; mz = L['mouth_z']
        self.center_y = None
        self.center_y = self.surface(0.0, mz)[0][1]

        def taper(x):
            return max(0.0, 1 - (x / a) ** 2) ** 0.5

        def line_z(x):  # 입선: 중앙 기준, 입꼬리로 갈수록 살짝 내려감
            return mz - o['corner_dip'] * (x / a) ** 2

        def top_z(x):  # 윗입술 상단 경계(큐피드 활: 중앙 살짝 파이고 ±0.4a 에서 봉우리)
            u = x / a
            cupid = 1 - 0.20 * math.exp(-(u / 0.16) ** 2) + 0.14 * math.exp(-((abs(u) - 0.42) / 0.2) ** 2)
            return line_z(x) + o['h_up'] * taper(x) ** 0.7 * cupid

        def bot_z(x):  # 아랫입술 하단 경계
            return line_z(x) - o['h_low'] * taper(x) ** 0.6

        cols, rows = o['cols'], o['rows']
        xs = [-a + 2 * a * k / cols for k in range(cols + 1)]
        # 그리드 생성: 각 입술은 (rows+1) × (cols+1) 정점. t=0 이 입선, t=1 이 바깥 경계.
        def lip_grid(upper):
            pts = []
            for r in range(rows + 1):
                t = r / rows
                row = []
                for x in xs:
                    z = line_z(x) + ((top_z(x) if upper else bot_z(x)) - line_z(x)) * t
                    dmax = (o['d_up'] if upper else o['d_low']) * taper(x) ** 0.8
                    # 두께: 입선(t=0)에서 line_d, 중간에서 최대, 바깥 경계(t=1)에서 0.02(피부와 z-fighting 방지)
                    bulge = math.sin(math.pi * min(1.0, t * (1.15 if upper else 1.05))) ** 0.85
                    d = max(0.02, o['line_d'] * (1 - t) ** 2 + dmax * bulge)
                    p, n = self.surface(x, z)
                    row.append([p[k] + n[k] * d * cm for k in range(3)])
                pts.append(row)
            return pts

        up = lip_grid(True); low = lip_grid(False)
        # 입선: 두 입술 t=0 행 사이의 얇은 띠 — 살짝 뒤로(line_d − 0.12) 들어가 어두운 선으로 읽힘
        line = []
        for x in xs:
            p, n = self.surface(x, line_z(x))
            d = (o['line_d'] - 0.12) * cm
            line.append([[p[k] + n[k] * d + (0, 0, 1)[k] * 0.045 * cm for k in range(3)],
                         [p[k] + n[k] * d - (0, 0, 1)[k] * 0.045 * cm for k in range(3)]])
        self.up, self.low, self.line = up, low, line
        return self

    # ── 메시 조립 ──
    def write(self):
        g = self.g; o = self.o; cols, rows = o['cols'], o['rows']
        head_j = g.jname.index('Head')
        P, N, UV, J, W = [], [], [], [], []
        prims = {}

        def add_quad(mat, a, b, c, d):
            """네 점(a,b,c,d 순환)을 플랫 쿼드로: 정점 4개를 복제하고 쿼드 평균 법선(앞=−y 쪽) 하나를 준다. 면적 0 이면 생략."""
            n1 = _tri_normal(a, b, c); n2 = _tri_normal(a, c, d)
            n = [n1[k] + n2[k] for k in range(3)]
            if math.sqrt(sum(x * x for x in n)) < 1e-9:
                return
            n = _norm(n)
            flip = n[1] > 0  # 법선이 뒤를 보면 와인딩·법선 반전
            if flip:
                n = [-x for x in n]
            base = len(P)
            for p in (a, b, c, d):
                P.append(list(p)); N.append(list(n)); UV.append([0.5, 0.5]); J.append([head_j, 0, 0, 0]); W.append([1.0, 0.0, 0.0, 0.0])
            q = [[base, base + 2, base + 1], [base, base + 3, base + 2]] if flip else [[base, base + 1, base + 2], [base, base + 2, base + 3]]
            prims.setdefault(mat, []).extend(q)

        for grid in (self.up, self.low):
            for r in range(rows):
                for c in range(cols):
                    add_quad('Lips', grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c])
        for c in range(cols):
            (t0, b0), (t1, b1) = self.line[c], self.line[c + 1]
            add_quad('MouthLine', t0, t1, b1, b0)
        # 접근자·프리미티브
        A = {
            'POSITION': g.add_accessor([tuple(x) for x in P], 5126, 'VEC3', target=34962),
            'NORMAL': g.add_accessor([tuple(x) for x in N], 5126, 'VEC3', target=34962),
            'TEXCOORD_0': g.add_accessor([tuple(x) for x in UV], 5126, 'VEC2', target=34962),
            'JOINTS_0': g.add_accessor([tuple(x) for x in J], 5123, 'VEC4', target=34962),
            'WEIGHTS_0': g.add_accessor([tuple(x) for x in W], 5126, 'VEC4', target=34962),
        }
        COLORS = {'Lips': o.get('lip_color', '#d39a86'), 'MouthLine': o.get('line_color', '#8a5448')}
        plist = []
        for mat, tris in prims.items():
            mi = g.material((mat, COLORS[mat]))
            pbr = g.js['materials'][mi].setdefault('pbrMetallicRoughness', {})
            pbr['metallicFactor'] = 0.0; pbr['roughnessFactor'] = 0.6  # 입술은 무광에 가깝게(체인의 matte 가 뒤에서 덮어써도 무방)
            plist.append({'attributes': dict(A), 'indices': g.add_indices([v for t in tris for v in t], 5123), 'material': mi, 'mode': 4})
        mesh = {'name': self.head_mesh.replace('Head', 'Mouth'), 'primitives': plist}
        g.js['meshes'].append(mesh)
        head_ni = next(i for i, nd in enumerate(g.nodes) if 'mesh' in nd and g.js['meshes'][nd['mesh']].get('name') == self.head_mesh)
        head_nd = g.nodes[head_ni]
        node = {'name': mesh['name'], 'mesh': len(g.js['meshes']) - 1}
        if 'skin' in head_nd:
            node['skin'] = head_nd['skin']
        g.nodes.append(node); ni = len(g.nodes) - 1
        parent = next((nd for nd in g.nodes if head_ni in nd.get('children', [])), None)
        if parent is not None:
            parent['children'].append(ni)
        else:
            g.js['scenes'][g.js.get('scene', 0)]['nodes'].append(ni)
        L = self.L
        print(f"  lips [{self.head_mesh}]: 입 중심 z={L['mouth_z']:.2f}cm(턱 {L['chin_z']:.2f}·코밑 {L['nose_base_z']:.2f}) 반폭 {L['a']:.2f}cm, "
              f"윗입술 {o['h_up']}cm/두께 {o['d_up']}cm · 아랫입술 {o['h_low']}cm/두께 {o['d_low']}cm, 정점 {len(P)}, 삼각형 {sum(len(t) for t in prims.values())}")


def add_mouth(g, head_mesh, skin_mat='Skin', **opts):
    LipsBuilder(g, head_mesh, skin_mat, opts).build().write()
