#!/usr/bin/env python3
"""저폴리(무텍스처·재질 색) 캐릭터 GLB 의복·헤어 재구성 도구 (의존성 없음).

규칙(RULES)에 따라
  ('material', mesh, prim, (재질명, 색))            프리미티브 전체 재질 교체
  ('split', mesh, prim, (재질명, 색), 술어)         술어가 참인 삼각형만 새 프리미티브로 분리·재질 교체
  ('recolor', 재질명, '#hex')                        기존 재질 색 변경
  ('pants_tube', {...})                              다리 피부 정점을 축 기준 방사 확장해 바지 통으로 만든다
  ('hair_swap', {...})                               다른 GLB(같은 리그 계열)의 헤어 프리미티브를 이식
  ('hair_perm', {...})                               헤어 정점을 둥근 캡+웨이브로 변형(애즈펌 느낌)
을 적용한다. 정점 좌표 수정이 필요한 프리미티브는 속성 접근자를 복제해 공유 정점의 다른 프리미티브에 영향이 없게 한다.

usage: python3 restyle_outfit.py in.glb out.glb --rules cand2_casual [--donor donor.glb]
"""
import argparse, json, math, struct, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from measure_glb import read_glb, accessor, minv, ibm_mats  # noqa: E402
except ImportError:
    from analyze_glb import read_glb, accessor, minv, ibm_mats  # noqa: E402

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
CT_FMT = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def srgb_to_linear(hexstr):
    h = hexstr.lstrip('#')
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return [round(v, 4) for v in out] + [1.0]


class Glb:
    def __init__(self, path):
        self.js, b = read_glb(path)
        self.bin = bytearray(b)
        self.nodes = self.js['nodes']
        sk = self.js['skins'][0]
        self.jname = [self.nodes[j]['name'] for j in sk['joints']]
        ib = ibm_mats(self.js, self.bin, sk)
        self.jpos = {}
        for k, n in enumerate(self.jname):
            B = minv(ib[k])
            self.jpos[n] = (B[0][3], B[1][3], B[2][3]) if B else (0, 0, 0)
        self._mat_cache = {m.get('name'): i for i, m in enumerate(self.js['materials'])}
        # 바인드 공간 위 축 판정 (Blender 내보내기는 z-up 인 경우가 많다): Head−Foot 방향의 최대 성분
        h, f = self.jpos.get('Head', (0, 1, 0)), self.jpos.get('Foot.L', self.jpos.get('Foot.R', (0, 0, 0)))
        d = [abs(h[i] - f[i]) for i in range(3)]
        self.UP = d.index(max(d))
        # 좌우 축: UpperLeg.L 과 .R 의 차가 큰 축
        l, r = self.jpos.get('UpperLeg.L', (1, 0, 0)), self.jpos.get('UpperLeg.R', (-1, 0, 0))
        dl = [abs(l[i] - r[i]) if i != self.UP else -1 for i in range(3)]
        self.LAT = dl.index(max(dl))
        self.DEP = 3 - self.UP - self.LAT
        self.LAT_SIGN = 1 if l[self.LAT] >= r[self.LAT] else -1  # .L 이 양의 방향인지

    # ── 재질 ──
    def material(self, spec):
        name, color = spec
        if name in self._mat_cache and color is None:
            return self._mat_cache[name]
        if name in self._mat_cache and self.js['materials'][self._mat_cache[name]].get('_restyle'):
            return self._mat_cache[name]
        mats = self.js['materials']
        base = next(m for m in mats if m.get('name') == 'Skin')
        m = json.loads(json.dumps(base))
        m['name'] = name; m['_restyle'] = True
        if color.startswith('#'):
            m['pbrMetallicRoughness']['baseColorFactor'] = srgb_to_linear(color)
        else:
            src = next(x for x in mats if x.get('name') == color)
            m['pbrMetallicRoughness']['baseColorFactor'] = list(src['pbrMetallicRoughness']['baseColorFactor'])
        mats.append(m)
        self._mat_cache[name] = len(mats) - 1
        return self._mat_cache[name]

    def recolor(self, name, hexcolor):
        m = self.js['materials'][self._mat_cache[name]]
        m['pbrMetallicRoughness']['baseColorFactor'] = srgb_to_linear(hexcolor)

    # ── 메시/접근자 ──
    def mesh_prim(self, mesh_name, pi):
        for nd in self.nodes:
            if 'mesh' in nd and self.js['meshes'][nd['mesh']].get('name') == mesh_name:
                m = self.js['meshes'][nd['mesh']]
                return m, m['primitives'][pi]
        raise KeyError(mesh_name)

    def mesh_by_name(self, mesh_name):
        return self.mesh_prim(mesh_name, 0)[0]

    def add_accessor(self, rows, component_type, type_, target=None, normalized=False):
        n = NC[type_]
        fmt, size = CT_FMT[component_type]
        pad = (4 - len(self.bin) % 4) % 4
        self.bin += b'\x00' * pad
        off = len(self.bin)
        flat = [c for r in rows for c in (r if n > 1 else (r,))]
        self.bin += struct.pack('<' + fmt * len(flat), *flat)
        bv = {'buffer': 0, 'byteOffset': off, 'byteLength': len(flat) * size}
        if target:
            bv['target'] = target
        self.js['bufferViews'].append(bv)
        acc = {'bufferView': len(self.js['bufferViews']) - 1, 'componentType': component_type, 'count': len(rows), 'type': type_}
        if normalized:
            acc['normalized'] = True
        if n > 1:
            acc['min'] = [min(r[k] for r in rows) for k in range(n)]; acc['max'] = [max(r[k] for r in rows) for k in range(n)]
        else:
            acc['min'] = [min(rows)]; acc['max'] = [max(rows)]
        self.js['accessors'].append(acc)
        return len(self.js['accessors']) - 1

    def add_indices(self, values, component_type):
        return self.add_accessor(values, component_type, 'SCALAR', target=34963)

    def privatize(self, p, attrs=('POSITION', 'NORMAL')):
        """프리미티브의 속성 접근자를 복제해 다른 프리미티브와 정점 공유를 끊는다."""
        for a in attrs:
            if a not in p['attributes']:
                continue
            ai = p['attributes'][a]
            acc = self.js['accessors'][ai]
            rows = accessor(self.js, self.bin, ai)
            p['attributes'][a] = self.add_accessor(rows, acc['componentType'], acc['type'], target=34962, normalized=acc.get('normalized', False))

    def write_rows(self, ai, rows):
        acc = self.js['accessors'][ai]
        n = NC[acc['type']]; fmt, size = CT_FMT[acc['componentType']]
        bv = self.js['bufferViews'][acc['bufferView']]
        off = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
        stride = bv.get('byteStride', n * size)
        for i, r in enumerate(rows):
            struct.pack_into('<' + fmt * n, self.bin, off + i * stride, *r)
        if n > 1:
            acc['min'] = [min(r[k] for r in rows) for k in range(n)]; acc['max'] = [max(r[k] for r in rows) for k in range(n)]

    def dom_bones(self, p):
        J = accessor(self.js, self.bin, p['attributes']['JOINTS_0'])
        W = accessor(self.js, self.bin, p['attributes']['WEIGHTS_0'])
        return [self.jname[int(jj[max(range(4), key=lambda a: ww[a])])] for jj, ww in zip(J, W)]

    def tri_info(self, p, sleeve_axis):
        pos = accessor(self.js, self.bin, p['attributes']['POSITION'])
        dom = self.dom_bones(p)
        idx = accessor(self.js, self.bin, p['indices'])
        tris = []
        for t in range(len(idx) // 3):
            vs = idx[3 * t:3 * t + 3]
            bones = {dom[v] for v in vs}
            tval = None
            for ua, la in sleeve_axis.items():
                if ua in bones:
                    a, b_ = self.jpos[ua], self.jpos[la]
                    ax = tuple(b_[i] - a[i] for i in range(3))
                    L2 = sum(c * c for c in ax) or 1e-12
                    c = [sum(pos[v][i] for v in vs) / 3 for i in range(3)]
                    tval = sum((c[i] - a[i]) * ax[i] for i in range(3)) / L2
                    break
            cen = [sum(pos[v][i] for v in vs) / 3 for i in range(3)]
            tris.append({'bones': bones, 't': tval, 'idx': vs, 'up': cen[self.UP]})
        return tris, self.js['accessors'][p['indices']]['componentType']

    # ── 규칙 실행 ──
    def apply(self, rules, donor=None):
        for rule in rules:
            kind = rule[0]
            if kind == 'material':
                _, mesh_name, pi, mat = rule
                _, p = self.mesh_prim(mesh_name, pi)
                p['material'] = self.material(mat)
            elif kind == 'split':
                _, mesh_name, pi, mat, pred = rule[:5]
                sleeve_axis = rule[5] if len(rule) > 5 else {}
                mesh, p = self.mesh_prim(mesh_name, pi)
                mi = self.material(mat)
                tris, ctype = self.tri_info(p, sleeve_axis)
                keep, move = [], []
                for tr in tris:
                    (move if pred(tr) else keep).append(tr['idx'])
                if not move:
                    print(f'  [{mesh_name}#{pi}] 술어 일치 삼각형 없음'); continue
                if keep:
                    p['indices'] = self.add_indices([v for tr in keep for v in tr], ctype)
                newp = json.loads(json.dumps(p))
                newp['material'] = mi
                newp['indices'] = self.add_indices([v for tr in move for v in tr], ctype)
                mesh['primitives'].append(newp)
                if not keep:
                    mesh['primitives'].remove(p)
                print(f'  [{mesh_name}#{pi}] {len(move)} tris → {mat[0]}, {len(keep)} 유지')
            elif kind == 'recolor':
                self.recolor(rule[1], rule[2]); print(f'  recolor {rule[1]} → {rule[2]}')
            elif kind == 'pants_tube':
                self.pants_tube(**rule[1])
            elif kind == 'hair_swap':
                self.hair_swap(donor, **rule[1])
            elif kind == 'hair_perm':
                self.hair_perm(**rule[1])
            else:
                raise ValueError(kind)

    # ── 바지 통 ──
    def _leg_side(self, v, dom):
        if dom.endswith('.L'):
            return 'L'
        if dom.endswith('.R'):
            return 'R'
        return 'L' if v[self.LAT] * self.LAT_SIGN >= 0 else 'R'

    def prim_top(self, mesh_name, pi):
        _, p = self.mesh_prim(mesh_name, pi)
        pos = accessor(self.js, self.bin, p['attributes']['POSITION'])
        return max(v[self.UP] for v in pos)

    def pants_tube(self, leg_prims, hem_prim, shoe_prim=None, cuff_ratio=0.72, min_factor=1.0, max_factor=2.2, nb=14, floor=None):
        """leg_prims: [(mesh, prim_index)] 바지가 될 다리 피부 프리미티브(정점 좌표를 수정).
        hem_prim: (mesh, prim_index) 반바지 — 최하단 밴드 반경이 바지 통 최상단 목표.
        shoe_prim: (mesh, prim_index) 신발 — 상단 반경보다 살짝 크게 밑단을 만든다.
        목표 반경 r(y) = 밑단(hem)에서 cuff 까지 선형 보간. 각 정점은 밴드 중심 기준으로 방사 확장(축소 없음)."""
        # 1) 반바지 밑단 반경
        UP, LAT, DEP = self.UP, self.LAT, self.DEP

        def band_stats(pts, y_lo, y_hi):
            b = [p for p in pts if y_lo <= p[UP] <= y_hi]
            if len(b) < 3:
                return None
            cx = sum(p[LAT] for p in b) / len(b); cz = sum(p[DEP] for p in b) / len(b)
            return cx, cz, sum(math.hypot(p[LAT] - cx, p[DEP] - cz) for p in b) / len(b)

        _, hp = self.mesh_prim(*hem_prim)
        hpos = accessor(self.js, self.bin, hp['attributes']['POSITION']); hdom = self.dom_bones(hp)
        # 2) 다리 프리미티브 정점 수집(측별)
        legs = {'L': [], 'R': []}
        prim_data = []
        for mesh_name, pi in leg_prims:
            _, p = self.mesh_prim(mesh_name, pi)
            self.privatize(p)
            pos = accessor(self.js, self.bin, p['attributes']['POSITION'])
            dom = self.dom_bones(p)
            prim_data.append((mesh_name, pi, p, pos, dom))
            for i, (v, d) in enumerate(zip(pos, dom)):
                if d.startswith('Foot') or (floor is not None and v[self.UP] < floor):
                    continue  # 발·신발 높이 아래는 수정 안 함
                legs[self._leg_side(v, d)].append(v)
        report = {}
        for side in ('L', 'R'):
            pts = legs[side]
            if not pts:
                continue
            y_top = max(p[UP] for p in pts); y_bot = min(p[UP] for p in pts)
            # 반바지 밑단: 같은 측 반바지 정점 중 높이 하위 8~18% 밴드 (최하단 림의 안쪽 정점은 제외)
            hs = [v for v, d in zip(hpos, hdom) if self._leg_side(v, d) == side]
            hy0 = min(p[UP] for p in hs); hy1 = max(p[UP] for p in hs)
            hem = band_stats(hs, hy0 + (hy1 - hy0) * 0.08, hy0 + (hy1 - hy0) * 0.18)
            r_hem = hem[2]
            r_cuff = r_hem * cuff_ratio
            if shoe_prim:
                _, sp = self.mesh_prim(*shoe_prim)
                spos = accessor(self.js, self.bin, sp['attributes']['POSITION']); sdom = self.dom_bones(sp)
                ss = [v for v, d in zip(spos, sdom) if self._leg_side(v, d) == side]
                sy1 = max(p[UP] for p in ss)
                shoe_top = band_stats(ss, sy1 - (sy1 - min(p[UP] for p in ss)) * 0.15, sy1)
                if shoe_top:
                    r_cuff = max(r_cuff, shoe_top[2] * 1.12)
            # 밴드별 중심·평균 반경(다리 피부 자체)
            bands = []
            for i in range(nb):
                lo = y_bot + (y_top - y_bot) * i / nb; hi = y_bot + (y_top - y_bot) * (i + 1) / nb
                st = band_stats(pts, lo, hi + 1e-9)
                bands.append((lo, hi, st))
            # 빈 밴드는 이웃 보간
            for i in range(nb):
                if bands[i][2] is None:
                    j = next((k for k in range(i + 1, nb) if bands[k][2]), None); h = next((k for k in range(i - 1, -1, -1) if bands[k][2]), None)
                    ref = bands[j][2] if j is not None else bands[h][2]
                    bands[i] = (bands[i][0], bands[i][1], ref)

            def target_r(y):
                s = (y_top - y) / (y_top - y_bot) if y_top > y_bot else 0
                s = min(1.0, max(0.0, s))
                return r_hem + (r_cuff - r_hem) * s

            def band_of(y):
                i = int((y - y_bot) / (y_top - y_bot) * nb) if y_top > y_bot else 0
                return bands[min(nb - 1, max(0, i))][2]

            factors = []
            for mesh_name, pi, p, pos, dom in prim_data:
                new = list(pos)
                changed = False
                for i, (v, d) in enumerate(zip(pos, dom)):
                    if d.startswith('Foot') or self._leg_side(v, d) != side or (floor is not None and v[UP] < floor):
                        continue
                    cx, cz, r_band = band_of(v[UP])
                    k = max(min_factor, min(max_factor, target_r(v[UP]) / r_band)) if r_band > 1e-9 else 1.0
                    dx, dz = v[LAT] - cx, v[DEP] - cz
                    nv = list(v); nv[LAT] = cx + dx * k; nv[DEP] = cz + dz * k
                    new[i] = tuple(nv)
                    factors.append(k); changed = True
                if changed:
                    self.write_rows(p['attributes']['POSITION'], new)
                    pos[:] = new
            report[side] = dict(r_hem=round(r_hem, 5), r_cuff=round(r_cuff, 5), y_top=round(y_top, 4), y_bot=round(y_bot, 4),
                                k_min=round(min(factors), 3) if factors else None, k_max=round(max(factors), 3) if factors else None, n=len(factors))
        print('  pants_tube', json.dumps(report))

    # ── 헤어 이식 ──
    def hair_swap(self, donor, donor_mesh, donor_mat, target_mesh, target_mat='Hair', color=None):
        assert donor is not None, 'donor GLB 필요'
        dmesh = donor.mesh_by_name(donor_mesh)
        dp = next(p for p in dmesh['primitives'] if donor.js['materials'][p['material']].get('name') == donor_mat)
        tmesh = self.mesh_by_name(target_mesh)
        # 기존 헤어 제거
        tmesh['primitives'] = [p for p in tmesh['primitives'] if self.js['materials'][p['material']].get('name') != target_mat]
        # 관절 인덱스 재매핑(이름 기준)
        remap = {i: self.jname.index(n) for i, n in enumerate(donor.jname) if n in self.jname}
        newp = {'attributes': {}, 'mode': dp.get('mode', 4)}
        for a, ai in dp['attributes'].items():
            acc = donor.js['accessors'][ai]
            rows = accessor(donor.js, donor.bin, ai)
            if a == 'JOINTS_0':
                rows = [tuple(remap.get(int(c), 0) for c in r) for r in rows]
            newp['attributes'][a] = self.add_accessor(rows, acc['componentType'], acc['type'], target=34962, normalized=acc.get('normalized', False))
        idx = accessor(donor.js, donor.bin, dp['indices'])
        newp['indices'] = self.add_indices(idx, donor.js['accessors'][dp['indices']]['componentType'])
        newp['material'] = self.material((target_mat + '_swapped', color or '#4a2f1e'))
        tmesh['primitives'].append(newp)
        print(f'  hair_swap: {donor_mesh}/{donor_mat} → {target_mesh} ({len(idx)//3} tris)')

    # ── 애즈펌 변형 ──
    def hair_perm(self, mesh_name, mat='Hair', cap=1.0, wave_amp=0.06, wave_freq=7.0, flatten_top=0.0, keep_below=0.15, center_offset=(0, 0, 0)):
        """헤어 정점을 머리 중심 기준 구면 캡으로 눌러 뾰족한 스파이크를 없애고, 각도에 따른 웨이브로 볼륨감을 준다.
        cap: 캡 반경 = 두피(머리 피부) 최대 반경 × cap. 정점 반경이 캡을 넘으면 캡+웨이브로 클램프.
        keep_below: 머리 관절 기준 이 비율 높이 아래(구레나룻·뒷머리 아랫단)는 변형 제외."""
        mesh = self.mesh_by_name(mesh_name)
        hp = next(p for p in mesh['primitives'] if self.js['materials'][p['material']].get('name') == mat)
        skin = next(p for p in mesh['primitives'] if self.js['materials'][p['material']].get('name') == 'Skin')
        spos = accessor(self.js, self.bin, skin['attributes']['POSITION'])
        hc = self.jpos['Head']
        # 머리 중심: 두피 정점 평균 (관절은 턱 근처라 위로 올림)
        UP = self.UP
        top = max(p[UP] for p in spos)
        cy = hc[UP] + (top - hc[UP]) * 0.55
        c = [hc[i] + center_offset[i] for i in range(3)]; c[UP] = cy + center_offset[UP]; c = tuple(c)
        r_skin = max(math.dist(p, c) for p in spos if p[UP] > cy)
        R = r_skin * cap
        self.privatize(hp)
        pos = accessor(self.js, self.bin, hp['attributes']['POSITION'])
        new = []
        nclamp = 0
        for v in pos:
            d = (v[0] - c[0], v[1] - c[1], v[2] - c[2])
            r = math.sqrt(sum(x * x for x in d)) or 1e-9
            if v[UP] < hc[UP] + (top - hc[UP]) * keep_below:
                new.append(v); continue
            u = (d[0] / r, d[1] / r, d[2] / r)
            # 웨이브: 방위각·고도각 기반 결정적 범프 (up 축 기준)
            lat, dep = [i for i in range(3) if i != UP]
            az = math.atan2(u[lat], u[dep]); el = math.asin(max(-1, min(1, u[UP])))
            wave = 1 + wave_amp * (0.5 * math.sin(wave_freq * az + 1.3 * el) + 0.5 * math.sin(wave_freq * 0.7 * el * 3 + 2.1 * az))
            Rw = R * wave * (1 - flatten_top * max(0.0, u[UP]) ** 2)
            if r > Rw:
                new.append((c[0] + u[0] * Rw, c[1] + u[1] * Rw, c[2] + u[2] * Rw)); nclamp += 1
            else:
                new.append(v)
        self.write_rows(hp['attributes']['POSITION'], new)
        print(f'  hair_perm: R={R:.4f} (skin {r_skin:.4f}) clamped {nclamp}/{len(pos)}')

    def save(self, path):
        for m in self.js['materials']:
            m.pop('_restyle', None)
        self.js['buffers'][0]['byteLength'] = len(self.bin)
        jb = json.dumps(self.js, separators=(',', ':')).encode()
        jb += b' ' * ((4 - len(jb) % 4) % 4)
        bb = bytes(self.bin) + b'\x00' * ((4 - len(self.bin) % 4) % 4)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(jb) + 8 + len(bb)))
            f.write(struct.pack('<II', len(jb), JSON_CHUNK)); f.write(jb)
            f.write(struct.pack('<II', len(bb), BIN_CHUNK)); f.write(bb)


# ── 모델별 규칙 ───────────────────────────────────────────────
HAIR_BROWN = '#5a3a24'
SLEEVE_AXIS = {'UpperArm.L': 'LowerArm.L', 'UpperArm.R': 'LowerArm.R'}


def cand2_rules(opts):
    PANTS = ('Pants', '#3a4557'); SHOES = ('Shoes', '#2e2a28'); SHIRT = ('Shirt', 'LightBrown')

    def sleeve(tri):
        b = tri['bones']
        if b & {'Chest', 'Torso', 'Abdomen', 'Hips', 'Body', 'Shoulder.L', 'Shoulder.R'}:
            return True
        if b & {'UpperArm.L', 'UpperArm.R'}:
            return tri['t'] is not None and tri['t'] < 0.62
        return False

    shoe_top = opts.get('_shoe_top')  # 실행 시 주입

    def shoe(tri):
        return bool(tri['bones'] & {'Foot.L', 'Foot.R'}) or (shoe_top is not None and tri['up'] < shoe_top)

    rules = [
        ('material', 'Beach_Legs', 0, PANTS), ('material', 'Beach_Legs', 1, PANTS), ('material', 'Beach_Legs', 2, PANTS),
        ('material', 'Beach_Feet', 1, SHOES),
        ('split', 'Beach_Feet', 0, SHOES, shoe),
        ('material', 'Beach_Feet', 0, PANTS),
        ('split', 'Beach_Body', 0, SHIRT, sleeve, SLEEVE_AXIS),
        # 바지 통: 다리 피부(Beach_Legs#0) + 발목 피부(Beach_Feet#0, 발 제외) 를 반바지 밑단 굵기에서 밑단까지 확장
        ('pants_tube', dict(leg_prims=[('Beach_Legs', 0), ('Beach_Feet', 0)], hem_prim=('Beach_Legs', 1), shoe_prim=('Beach_Feet', 1),
                            cuff_ratio=opts.get('cuff_ratio', 0.72), floor=shoe_top)),
        ('recolor', 'Hair', HAIR_BROWN),
    ]
    if opts.get('hair') == 'swap':
        rules.append(('hair_swap', dict(donor_mesh=opts['donor_mesh'], donor_mat=opts.get('donor_mat', 'Hair'), target_mesh='Beach_Head', color=HAIR_BROWN)))
    if opts.get('perm'):
        rules.append(('hair_perm', dict(mesh_name='Beach_Head', mat=opts.get('perm_mat', 'Hair'), **opts['perm'])))
    return rules


def cand1_rules(opts):
    return [('recolor', 'Hair_Blond', HAIR_BROWN), ('recolor', 'Hair_Brown', '#3b2416')]


RULES = {'cand2_casual': cand2_rules, 'cand1_casual': cand1_rules}

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('dst'); ap.add_argument('--rules', required=True, choices=sorted(RULES))
    ap.add_argument('--donor'); ap.add_argument('--opts', default='{}', help='JSON 옵션')
    a = ap.parse_args()
    opts = json.loads(a.opts)
    g = Glb(a.src)
    donor = Glb(a.donor) if a.donor else None
    if a.rules == 'cand2_casual':
        opts['_shoe_top'] = g.prim_top('Beach_Feet', 1) * 0.98  # 샌들 상단 높이 → 그 아래는 신발
    g.apply(RULES[a.rules](opts), donor=donor)
    g.save(a.dst)
    print('saved', a.dst)
