#!/usr/bin/env python3
"""저폴리(무텍스처·재질 색) 캐릭터 GLB 의복·헤어 재구성 도구 (의존성 없음).

규칙(RULES)에 따라
  ('material', mesh, prim, (재질명, 색))            프리미티브 전체 재질 교체
  ('split', mesh, prim, (재질명, 색), 술어)         술어가 참인 삼각형만 새 프리미티브로 분리·재질 교체
  ('recolor', 재질명, '#hex')                        기존 재질 색 변경
  ('elbow_subdiv', {...})                            팔꿈치 띠 삼각형 1:4 분할(균열 방지)·가중치 스무딩으로 굽힘 뭉개짐 완화
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
                shell = rule[6] if len(rule) > 6 else None  # 미터 단위 두께: 피부 위에 띄운 천 쉘(진짜 소매단) — 원 삼각형은 피부로 유지
                if shell:
                    # 쉘과 같은 면을 이뤄야 하는 기존 옷 프리미티브(예: 원본 탱크톱 = 몸통 표면)도 같은 두께로 함께 띄운다(8번째 인자)
                    extra = [self.mesh_prim(mn, epi)[1] for mn, epi in (rule[7] if len(rule) > 7 else [])]
                    newp = json.loads(json.dumps(p))
                    self.privatize(newp)
                    for ep in extra:
                        self.privatize(ep)
                    hb = self.jpos['Head']; fb = self.jpos.get('Foot.L', self.jpos.get('Foot.R'))
                    units_per_m = math.dist(hb, fb) / (0.87 * 1.75)  # 머리 관절≈0.87H, H≈1.75m 가정
                    d = shell * units_per_m
                    # 저폴리 메시는 정점이 삼각형마다 복제돼 있어(플랫 법선) 정점별 법선으로 띄우면 모서리마다 쉘이 벌어진다 →
                    # 같은 좌표의 정점 법선을 (쉘·추가 프리미티브 통틀어) 합쳐(welded normal) 한 방향으로 띄워 면을 닫는다
                    targets = [newp] + extra
                    data = [(accessor(self.js, self.bin, t['attributes']['POSITION']), accessor(self.js, self.bin, t['attributes']['NORMAL'])) for t in targets]
                    scale = max(1e-12, max(abs(c) for pos, _ in data for v in pos for c in v))
                    welded = {}
                    for pos, nrm in data:
                        for pp, nn in zip(pos, nrm):
                            w = welded.setdefault(tuple(round(c / scale, 6) for c in pp), [0.0, 0.0, 0.0])
                            for j in range(3):
                                w[j] += nn[j]

                    def wn(pp, nn):
                        w = welded[tuple(round(c / scale, 6) for c in pp)]
                        L = math.sqrt(sum(c * c for c in w))
                        return [c / L for c in w] if L > 1e-9 else list(nn)
                    for t, (pos, nrm) in zip(targets, data):
                        self.write_rows(t['attributes']['POSITION'], [tuple(pp[k] + wn(pp, nn)[k] * d for k in range(3)) for pp, nn in zip(pos, nrm)])
                    newp['material'] = mi
                    newp['indices'] = self.add_indices([v for tr in move for v in tr], ctype)
                    mesh['primitives'].append(newp)
                    print(f'  [{mesh_name}#{pi}] {len(move)} tris → {mat[0]} 쉘(+{shell*1000:.0f}mm, 함께 띄운 프리미티브 {len(extra)}), 피부 {len(tris)} 유지')
                    continue
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
            elif kind == 'elbow_subdiv':
                kw = dict(rule[1])
                if kw.get('meshes') == '__body__':
                    kw['meshes'] = self.body_meshes()
                self.elbow_subdiv(**kw)
            elif kind == 'arm_thicken':
                kw = dict(rule[1])
                if kw.get('meshes') == '__body__':
                    kw['meshes'] = self.body_meshes()
                self.arm_thicken(**kw)
            elif kind == 'height':
                self.set_height(rule[1])
            elif kind == 'matte':
                self.matte(**rule[1])
            elif kind == 'hair_transplant':
                self.hair_transplant(donor, **rule[1])
            else:
                raise ValueError(kind)

    def body_meshes(self):
        return [self.js['meshes'][nd['mesh']]['name'] for nd in self.nodes if 'mesh' in nd and self.js['meshes'][nd['mesh']].get('name', '').endswith('Body')]

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

    # ── 팔꿈치·겨드랑이 살짝 두껍게 ──
    def arm_thicken(self, meshes, elbow_gain=0.06, elbow_width=0.22, pit_gain=0.05, pit_center=0.28, pit_width=0.22, r_max_ratio=2.0):
        """팔 축(UpperArm→LowerArm→Wrist) 기준 방사 확장을 종 모양으로 가산한다.
        elbow: 상완 축 t=1(팔꿈치) 중심, pit: 상완 축 t=pit_center(겨드랑이 아래 상완) 중심. gain 은 최대 배율-1.
        r_max_ratio: 축에서 상완 평균 반경의 이 배수보다 먼 정점(몸통 중심 등)은 제외."""
        done = set(); nmod = 0
        for side in ('L', 'R'):
            a, e, w = self.jpos['UpperArm.' + side], self.jpos['LowerArm.' + side], self.jpos['Wrist.' + side]

            def proj(v, p0, p1):
                ax = [p1[i] - p0[i] for i in range(3)]; L2 = sum(c * c for c in ax) or 1e-12
                t = sum((v[i] - p0[i]) * ax[i] for i in range(3)) / L2
                q = [p0[i] + ax[i] * t for i in range(3)]
                return t, q, math.dist(v, q)

            # 상완 평균 반경(제외 반경 기준)
            rs = []
            for mesh_name in meshes:
                mesh = self.mesh_by_name(mesh_name)
                for p in mesh['primitives']:
                    pos = accessor(self.js, self.bin, p['attributes']['POSITION']); dom = self.dom_bones(p)
                    for v, d in zip(pos, dom):
                        if d == 'UpperArm.' + side:
                            t, q, r = proj(v, a, e)
                            if 0.3 < t < 0.8:
                                rs.append(r)
            r_ref = (sum(rs) / len(rs)) if rs else 0
            for mesh_name in meshes:
                mesh = self.mesh_by_name(mesh_name)
                for p in mesh['primitives']:
                    ai = p['attributes']['POSITION']
                    if (ai, side) in done:
                        continue
                    done.add((ai, side))
                    pos = accessor(self.js, self.bin, ai)
                    new = list(pos); changed = False
                    for i, v in enumerate(pos):
                        # 어느 팔인지: 상완 축 투영 반경이 기준 반경의 r_max_ratio 배 이내
                        tu, qu, ru = proj(v, a, e)
                        tl, ql, rl = proj(v, e, w)
                        if -0.35 < tu < 1.0 or (tl >= 0 and tu >= 1.0):
                            if tu < 1.0:
                                t_ax, q, r = tu, qu, ru
                            else:
                                t_ax, q, r = 1.0 + tl, ql, rl  # 팔꿈치 이후는 하완 축 기준
                            if r_ref <= 0 or r > r_ref * r_max_ratio:
                                continue
                            k = 1.0
                            k += elbow_gain * math.exp(-((t_ax - 1.0) / elbow_width) ** 2)
                            k += pit_gain * math.exp(-((t_ax - pit_center) / pit_width) ** 2)
                            if k > 1.0005:
                                new[i] = tuple(q[j] + (v[j] - q[j]) * k for j in range(3)); changed = True; nmod += 1
                    if changed:
                        self.write_rows(ai, new)
        print(f'  arm_thicken: elbow +{elbow_gain*100:.0f}% pit +{pit_gain*100:.0f}% ({nmod} 정점)')


    # ── 팔꿈치 정점 분할 ──
    def elbow_subdiv(self, meshes, iters=1, t0=0.72, t1=1.38, smooth=0.0, r_max_ratio=2.0):
        """팔꿈치 띠(상완 축 t∈[t0,t1], 팔꿈치=1.0, 하완은 1+t') 안의 삼각형을 1:4 로 분할해 굽힘 스키닝의 뭉개짐을 줄인다.
        띠 경계에 접한 삼각형은 균열(T-junction)이 생기지 않게 1:2·1:3 으로 함께 분할한다. 저폴리 메시는 정점이 삼각형마다
        복제돼 있으므로(플랫 셰이딩) 변은 인덱스가 아니라 **좌표**로 식별하고, 중점의 위치·관절 가중치는 같은 변끼리 공유하며
        법선·UV 는 삼각형별로 보간한다. smooth>0 이면 띠 안 정점의 UpperArm↔LowerArm 가중치를 팔꿈치 중심 ±smooth(t 단위)
        smoothstep 으로 재배정해 전환을 매끄럽게 한다(다른 본 가중치는 유지, 띠 가장자리는 원 가중치로 혼합)."""
        sides = {}
        for side in ('L', 'R'):
            sides[side] = (self.jpos['UpperArm.' + side], self.jpos['LowerArm.' + side], self.jpos['Wrist.' + side])

        def proj(v, p0, p1):
            ax = [p1[i] - p0[i] for i in range(3)]; L2 = sum(c * c for c in ax) or 1e-12
            t = sum((v[i] - p0[i]) * ax[i] for i in range(3)) / L2
            q = [p0[i] + ax[i] * t for i in range(3)]
            return t, math.dist(v, q)

        def arm_t(v, r_ref):
            """(side, t_ax, r) — 팔 축에 충분히 가까운 정점만, 아니면 None"""
            best = None
            for side, (a, e, w) in sides.items():
                tu, ru = proj(v, a, e); tl, rl = proj(v, e, w)
                t_ax, r = (tu, ru) if tu < 1.0 else (1.0 + tl, rl)
                if r_ref[side] > 0 and r <= r_ref[side] * r_max_ratio and (best is None or r < best[2]):
                    best = (side, t_ax, r)
            return best

        def top4(wmap):
            top = sorted(wmap.items(), key=lambda kv: -kv[1])[:4]
            S = sum(w for _, w in top) or 1.0
            top += [(0, 0.0)] * (4 - len(top))
            return [int(j) for j, _ in top], [w / S for _, w in top]

        total_added = 0
        for mesh_name in meshes:
            mesh = self.mesh_by_name(mesh_name)
            for p in mesh['primitives']:
                attrs = dict(p['attributes'])
                acc_meta = {a: self.js['accessors'][ai] for a, ai in attrs.items()}
                rows = {a: [list(r) if isinstance(r, (tuple, list)) else [r] for r in accessor(self.js, self.bin, ai)] for a, ai in attrs.items()}
                idx = list(accessor(self.js, self.bin, p['indices']))
                tris = [idx[3 * t:3 * t + 3] for t in range(len(idx) // 3)]
                used = set(idx)  # 쉘 프리미티브는 전체 정점 버퍼를 복제해 두었으므로 실제 사용 정점만 대상으로
                pos = rows['POSITION']
                dom = self.dom_bones(p)
                r_ref = {}
                for side in ('L', 'R'):
                    a, e, _ = sides[side]
                    rs = []
                    for i in used:
                        if dom[i] == 'UpperArm.' + side:
                            t, r = proj(pos[i], a, e)
                            if 0.3 < t < 0.8:
                                rs.append(r)
                    r_ref[side] = (sum(rs) / len(rs)) if rs else 0
                if not any(r_ref.values()):
                    continue
                scale = max(1e-12, max(abs(c) for v in pos for c in v))

                def pkey(i):
                    return tuple(round(c / scale, 6) for c in pos[i])

                def in_band(i):
                    at = arm_t(pos[i], r_ref)
                    return at is not None and t0 <= at[1] <= t1

                added = 0
                for _ in range(max(1, int(iters))):
                    band = {i for i in used if in_band(i)}
                    sel = [k for k, tr in enumerate(tris) if all(v in band for v in tr)]
                    if not sel:
                        break
                    shared = {}  # 좌표 변 키 → {'pos','J','W', 'by': {(u,v): 새 정점}}

                    def ekey(u, v):
                        ku, kv = pkey(u), pkey(v)
                        return (ku, kv) if ku <= kv else (kv, ku)

                    def mid(u, v):
                        ik = (u, v) if u < v else (v, u)
                        sh = shared.setdefault(ekey(u, v), {'by': {}})
                        if ik in sh['by']:
                            return sh['by'][ik]
                        if 'pos' not in sh:
                            sh['pos'] = [(pos[u][k] + pos[v][k]) / 2 for k in range(3)]
                            wm = {}
                            for jj, ww in list(zip(rows['JOINTS_0'][u], rows['WEIGHTS_0'][u])) + list(zip(rows['JOINTS_0'][v], rows['WEIGHTS_0'][v])):
                                wm[int(jj)] = wm.get(int(jj), 0.0) + ww / 2
                            sh['J'], sh['W'] = top4(wm)
                        for a in acc_meta:
                            ru, rv = rows[a][u], rows[a][v]
                            if a == 'POSITION':
                                rows[a].append(list(sh['pos']))
                            elif a == 'NORMAL':
                                n = [(ru[k] + rv[k]) / 2 for k in range(3)]; L = math.sqrt(sum(c * c for c in n)) or 1.0
                                rows[a].append([c / L for c in n])
                            elif a == 'JOINTS_0':
                                rows[a].append(list(sh['J']))
                            elif a == 'WEIGHTS_0':
                                rows[a].append(list(sh['W']))
                            else:
                                rows[a].append([(ru[k] + rv[k]) / 2 for k in range(len(ru))])
                        m = len(pos) - 1
                        sh['by'][ik] = m; used.add(m)
                        return m

                    for k in sel:
                        a_, b_, c_ = tris[k]
                        mid(a_, b_); mid(b_, c_); mid(c_, a_)

                    def gm(u, v):
                        # 같은 좌표 변이 어딘가에서 분할됐으면 이 삼각형에도 (자기 속성으로) 중점을 만든다 → 균열 방지
                        return mid(u, v) if ekey(u, v) in shared else None

                    new_tris = []
                    for a_, b_, c_ in tris:
                        m0, m1, m2 = gm(a_, b_), gm(b_, c_), gm(c_, a_)
                        n = sum(m is not None for m in (m0, m1, m2))
                        if n == 0:
                            new_tris.append([a_, b_, c_])
                        elif n == 3:
                            new_tris += [[a_, m0, m2], [m0, b_, m1], [m2, m1, c_], [m0, m1, m2]]
                        else:
                            V = [a_, b_, c_]; M = [m0, m1, m2]
                            while M[0] is None:  # 회전해 첫 변(a,b)에 중점이 있게
                                V = V[1:] + V[:1]; M = M[1:] + M[:1]
                            a_, b_, c_ = V; m0, m1, m2 = M
                            if n == 1:
                                new_tris += [[a_, m0, c_], [m0, b_, c_]]
                            elif m1 is not None:
                                new_tris += [[m0, b_, m1], [a_, m0, m1], [a_, m1, c_]]
                            else:
                                new_tris += [[a_, m0, m2], [m0, b_, m2], [m2, b_, c_]]
                    tris = new_tris
                    added += len(shared)
                if not added:
                    continue
                nsm = 0
                if smooth > 0:
                    JR, WR = rows['JOINTS_0'], rows['WEIGHTS_0']
                    for i in used:
                        at = arm_t(pos[i], r_ref)
                        if at is None or not (t0 <= at[1] <= t1):
                            continue
                        side, t_ax, _ = at
                        ju, jl = self.jname.index('UpperArm.' + side), self.jname.index('LowerArm.' + side)
                        wmap = {int(j): w for j, w in zip(JR[i], WR[i]) if w > 0}
                        S = wmap.get(ju, 0.0) + wmap.get(jl, 0.0)
                        if S <= 0:
                            continue
                        x = min(1.0, max(0.0, (t_ax - (1.0 - smooth)) / (2 * smooth)))
                        fl = x * x * (3 - 2 * x)
                        edge = min(t_ax - t0, t1 - t_ax) / max(1e-6, (t1 - t0) * 0.25)  # 띠 가장자리는 원 가중치로 복귀
                        k = min(1.0, max(0.0, edge))
                        new_l = (1 - k) * wmap.get(jl, 0.0) + k * S * fl
                        wmap[ju] = S - new_l; wmap[jl] = new_l
                        JR[i], WR[i] = top4(wmap); nsm += 1
                for a, meta in acc_meta.items():  # 새 정점은 끝에 추가되므로 기존 인덱스는 유지
                    r = rows[a]
                    r = [x[0] for x in r] if meta['type'] == 'SCALAR' else [tuple(x) for x in r]
                    p['attributes'][a] = self.add_accessor(r, meta['componentType'], meta['type'], target=34962, normalized=meta.get('normalized', False))
                ctype = 5125 if len(pos) > 65535 else self.js['accessors'][p['indices']]['componentType']
                p['indices'] = self.add_indices([v for tr in tris for v in tr], ctype)
                total_added += added
                print(f'  elbow_subdiv [{mesh_name}] mat={self.js["materials"][p.get("material", 0)].get("name")}: 변 {added} 분할, tris {len(idx)//3}→{len(tris)}, 스무딩 {nsm} 정점')
        print(f'  elbow_subdiv: iters={iters} band=[{t0},{t1}] smooth={smooth} (변 {total_added} 분할)')

    # ── 신장 설정 ──
    def set_height(self, height_m, include_hair=True):
        """씬 루트 노드에 균일 스케일을 곱해 기본 포즈 전체 높이(머리카락 포함)를 height_m 로 맞추고 asset.extras.heightM 에 기록."""
        import measure_glb as mg
        saved = mg.BIND_POSE; mg.BIND_POSE = False
        tris, _, _ = mg.collect(self.js, self.bin)
        mg.BIND_POSE = saved
        pts = [q for t in tris for q in t]
        h = max(q[1] for q in pts) - min(q[1] for q in pts)  # 노드 변환 적용 후 y-up 월드
        s = height_m / h
        for r in self.js['scenes'][0]['nodes']:
            nd = self.js['nodes'][r]
            if 'matrix' in nd:
                nd['matrix'] = [v * s if i < 12 else v for i, v in enumerate(nd['matrix'])]
            else:
                sc = nd.get('scale', [1, 1, 1]); nd['scale'] = [c * s for c in sc]
                tr = nd.get('translation', [0, 0, 0]); nd['translation'] = [c * s for c in tr]
        self.js.setdefault('asset', {}).setdefault('extras', {})['heightM'] = round(height_m, 3)
        print(f'  set_height: {h:.3f} → {height_m} m (×{s:.4f})')

    # ── 광택 제거 ──
    def matte(self, roughness=0.85, metallic=0.0):
        for m in self.js['materials']:
            p = m.setdefault('pbrMetallicRoughness', {})
            p['roughnessFactor'] = roughness; p['metallicFactor'] = metallic
            m.get('extensions', {}).pop('KHR_materials_specular', None)
        print(f'  matte: roughness {roughness} metallic {metallic} ({len(self.js["materials"])} 재질)')

    # ── 이종 리그 헤어 이식 (기존 환자 모델 → 후보) ──
    def head_bbox(self, mesh_name=None, mat='Skin'):
        """Head 본 지배 피부 정점 bbox (바인드 공간)"""
        pts = []
        for nd in self.nodes:
            if 'mesh' not in nd: continue
            mesh = self.js['meshes'][nd['mesh']]
            if mesh_name and mesh.get('name') != mesh_name: continue
            for p in mesh['primitives']:
                if self.js['materials'][p['material']].get('name') != mat: continue
                pos = accessor(self.js, self.bin, p['attributes']['POSITION']); dom = self.dom_bones(p)
                pts += [v for v, d in zip(pos, dom) if d == 'Head']
        return [min(v[i] for v in pts) for i in range(3)], [max(v[i] for v in pts) for i in range(3)]

    def hair_transplant(self, donor, donor_mat='Hair', donor_head_mat='Skin', donor_up=1, donor_fwd=2, donor_fwd_sign=1,
                        target_mesh='Beach_Head', target_fwd_sign=-1, color='#5a3a24', inflate=1.03, remove_prefix='Hair'):
        """리그가 다른 도너의 헤어 프리미티브를 대상 두상에 맞춰 회전·축별 스케일·정렬 후 Head 본에 100% 스키닝."""
        # 축 매핑: 도너 (lat, up, fwd) → 대상 (LAT, UP, DEP*sign)
        d_lat = 3 - donor_up - donor_fwd
        axes = {self.LAT: (d_lat, 1.0), self.UP: (donor_up, 1.0), self.DEP: (donor_fwd, target_fwd_sign * donor_fwd_sign)}
        def rot(v):
            out = [0.0, 0.0, 0.0]
            for ti, (di, sg) in axes.items():
                out[ti] = v[di] * sg
            return out
        # 회전 행렬 손잡이 검사: 좌우 반전이 필요하면 lat 부호 뒤집기
        e = [[1 if i == j else 0 for j in range(3)] for i in range(3)]
        cols = [rot(c) for c in e]
        det = (cols[0][0] * (cols[1][1] * cols[2][2] - cols[1][2] * cols[2][1]) - cols[1][0] * (cols[0][1] * cols[2][2] - cols[0][2] * cols[2][1]) + cols[2][0] * (cols[0][1] * cols[1][2] - cols[0][2] * cols[1][1]))
        lat_sign = -1.0 if det < 0 else 1.0
        axes[self.LAT] = (d_lat, lat_sign)
        # 두상 bbox: 도너(회전 후) ↔ 대상
        dmin, dmax = donor.head_bbox(mat=donor_head_mat)
        dmin_r, dmax_r = rot(dmin), rot(dmax)
        dlo = [min(a, b) for a, b in zip(dmin_r, dmax_r)]; dhi = [max(a, b) for a, b in zip(dmin_r, dmax_r)]
        tlo, thi = self.head_bbox(target_mesh)
        s = [(thi[i] - tlo[i]) / (dhi[i] - dlo[i]) for i in range(3)]
        # 정렬: lat/dep 중심 일치, up 은 정수리 일치
        c_d = [(dlo[i] + dhi[i]) / 2 for i in range(3)]; c_t = [(tlo[i] + thi[i]) / 2 for i in range(3)]
        c_d[self.UP] = dhi[self.UP]; c_t[self.UP] = thi[self.UP]
        # 대상 머리 중심(팽창 기준)
        hc = [(tlo[i] + thi[i]) / 2 for i in range(3)]
        def xform(v):
            r = rot(v)
            q = [c_t[i] + (r[i] - c_d[i]) * s[i] for i in range(3)]
            return tuple(hc[i] + (q[i] - hc[i]) * inflate for i in range(3))
        def nxform(n):
            r = rot(n); q = [r[i] / s[i] for i in range(3)]; L = math.sqrt(sum(x * x for x in q)) or 1.0
            return tuple(x / L for x in q)
        # 도너 헤어 프리미티브
        dp = None
        for nd in donor.nodes:
            if 'mesh' not in nd: continue
            for p in donor.js['meshes'][nd['mesh']]['primitives']:
                if donor.js['materials'][p['material']].get('name') == donor_mat:
                    dp = p; break
            if dp: break
        assert dp, 'donor hair primitive 없음'
        tmesh = self.mesh_by_name(target_mesh)
        tmesh['primitives'] = [p for p in tmesh['primitives'] if not self.js['materials'][p['material']].get('name', '').startswith(remove_prefix)]
        pos = [xform(v) for v in accessor(donor.js, donor.bin, dp['attributes']['POSITION'])]
        newp = {'attributes': {}, 'mode': dp.get('mode', 4)}
        newp['attributes']['POSITION'] = self.add_accessor(pos, 5126, 'VEC3', target=34962)
        if 'NORMAL' in dp['attributes']:
            nrm = [nxform(n) for n in accessor(donor.js, donor.bin, dp['attributes']['NORMAL'])]
            newp['attributes']['NORMAL'] = self.add_accessor(nrm, 5126, 'VEC3', target=34962)
        if 'TEXCOORD_0' in dp['attributes']:
            acc = donor.js['accessors'][dp['attributes']['TEXCOORD_0']]
            newp['attributes']['TEXCOORD_0'] = self.add_accessor(accessor(donor.js, donor.bin, dp['attributes']['TEXCOORD_0']), acc['componentType'], 'VEC2', target=34962, normalized=acc.get('normalized', False))
        hi = self.jname.index('Head')
        newp['attributes']['JOINTS_0'] = self.add_accessor([(hi, 0, 0, 0)] * len(pos), 5123, 'VEC4', target=34962)
        newp['attributes']['WEIGHTS_0'] = self.add_accessor([(1.0, 0.0, 0.0, 0.0)] * len(pos), 5126, 'VEC4', target=34962)
        idx = accessor(donor.js, donor.bin, dp['indices'])
        if lat_sign < 0:  # 반사 변환이면 삼각형 감김 뒤집기
            idx = [v for t in range(len(idx) // 3) for v in (idx[3 * t], idx[3 * t + 2], idx[3 * t + 1])]
        newp['indices'] = self.add_indices(idx, donor.js['accessors'][dp['indices']]['componentType'])
        newp['material'] = self.material(('Hair_old', color))
        tmesh['primitives'].append(newp)
        print(f'  hair_transplant: {len(idx)//3} tris, scale={[round(x,5) for x in s]}, lat_sign={lat_sign}, inflate={inflate}')

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
            return tri['t'] is not None and tri['t'] < 0.5  # 소매단은 상완 중간 — 팔꿈치 접힘에서 떨어뜨림
        return False

    shoe_top = opts.get('_shoe_top')  # 실행 시 주입

    def shoe(tri):
        return bool(tri['bones'] & {'Foot.L', 'Foot.R'}) or (shoe_top is not None and tri['up'] < shoe_top)

    rules = [
        ('material', 'Beach_Legs', 0, PANTS), ('material', 'Beach_Legs', 1, PANTS), ('material', 'Beach_Legs', 2, PANTS),
        ('material', 'Beach_Feet', 1, SHOES),
        ('split', 'Beach_Feet', 0, SHOES, shoe),
        ('material', 'Beach_Feet', 0, PANTS),
        ('split', 'Beach_Body', 0, SHIRT, sleeve, SLEEVE_AXIS, 0.004, [('Beach_Body', 1)]),  # 어깨·상완·몸통 피부 위 4mm 천 쉘 → 반팔 티(진짜 소매단, 피부 유지); 원본 탱크톱(#1, 몸통 표면)도 같은 면으로 띄움
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


# 공통 후처리: 팔꿈치·겨드랑이 살짝 두껍게(--opts '{"arm": true}') / 신장 설정(--opts '{"height": 1.83}')
def touch_rules(opts):
    rules = []
    if opts.get('elbow_subdiv'):  # 팔꿈치 띠 정점 분할(굽힘 뭉개짐 완화) — 팔 보정보다 먼저
        rules.append(('elbow_subdiv', dict(meshes='__body__', iters=int(opts['elbow_subdiv']), smooth=opts.get('elbow_smooth', 0.0),
                                           t0=opts.get('elbow_t0', 0.72), t1=opts.get('elbow_t1', 1.38))))
    if opts.get('arm', True):
        rules.append(('arm_thicken', dict(meshes='__body__', elbow_gain=opts.get('elbow_gain', 0.06), pit_gain=opts.get('pit_gain', 0.05))))
    if opts.get('matte'):  # 광택 제거: 후보 원본은 metallic 0.4·roughness 0.3~0.4 라 빛 반사가 심함
        rules.append(('matte', dict(roughness=opts.get('roughness', 0.85), metallic=opts.get('metallic', 0.0))))
    if opts.get('hair_old'):  # 기존 환자 모델(patient_male.glb, y-up·얼굴 +z) 헤어를 후보 두상에 이식 (--donor 필요)
        rules.append(('hair_transplant', dict(donor_mat='Hair', donor_up=1, donor_fwd=2, donor_fwd_sign=1, target_mesh=opts.get('target_mesh', 'Beach_Head'),
                                              target_fwd_sign=-1, color=HAIR_BROWN, inflate=opts.get('inflate', 1.03))))
    if opts.get('height'):
        rules.append(('height', float(opts['height'])))
    return rules


RULES = {'cand2_casual': cand2_rules, 'cand1_casual': cand1_rules, 'touch': touch_rules}

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
