#!/usr/bin/env python3
"""저폴리(무텍스처·재질 색) 캐릭터 GLB 의복 재배정 도구 (의존성 없음).

Quaternius 계열처럼 의복이 '몸 표면에 입힌 색 재질'인 모델은 피부 삼각형을 본 지배(스킨 가중치) 기준으로
골라 바지·소매·신발 재질로 옮기면 기하 수정 없이 평상복으로 바뀐다.

규칙은 RULES 에 모델별로 둔다:
  - ('material', mesh명, prim번호, 새재질)           : 프리미티브 전체 재질 교체
  - ('split', mesh명, prim번호, 새재질, 술어)         : 술어(삼각형 → bool)가 참인 삼각형만 새 프리미티브로 분리·재질 교체
술어에는 삼각형의 정점 지배 본 이름 집합과, 지정 본 축 상의 위치 비율(t) 이 제공된다.

usage: python3 restyle_outfit.py in.glb out.glb --rules cand2_casual
"""
import argparse, json, struct, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from measure_glb import read_glb, accessor, minv, ibm_mats  # noqa: E402

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def srgb_to_linear(hexstr):
    h = hexstr.lstrip('#')
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return [round(v, 4) for v in out] + [1.0]


# ── 모델별 규칙 ───────────────────────────────────────────────
# cand2 (Quaternius Beach Character): 민소매·반바지·샌들 → 반팔 티·긴바지·운동화
def cand2_rules():
    PANTS = ('Pants', '#3a4557')      # 짙은 청회색 면바지
    SHOES = ('Shoes', '#2e2a28')      # 짙은 갈회색 신발
    SHIRT = ('Shirt', 'LightBrown')   # 기존 민소매 재질 색을 그대로 반팔로 확장

    def sleeve(tri):
        # 어깨·상완(상단 62%)·몸통 피부 → 셔츠. 하완·손·목은 피부 유지
        b = tri['bones']
        if b & {'Chest', 'Torso', 'Abdomen', 'Hips', 'Body', 'Shoulder.L', 'Shoulder.R'}:
            return True
        if b & {'UpperArm.L', 'UpperArm.R'}:
            t = tri['t']
            return t is not None and t < 0.62
        return False

    def shoe(tri):
        return bool(tri['bones'] & {'Foot.L', 'Foot.R'})

    return [
        ('material', 'Beach_Legs', 0, PANTS),   # 무릎 아래 피부 → 바지
        ('material', 'Beach_Legs', 1, PANTS),   # 반바지 → 바지
        ('material', 'Beach_Legs', 2, PANTS),   # 반바지 흰 줄무늬 → 바지
        ('material', 'Beach_Feet', 1, SHOES),   # 샌들 → 신발
        ('split', 'Beach_Feet', 0, SHOES, shoe),  # 발 피부 → 신발 (발목 위 피부는 바지)
        ('material', 'Beach_Feet', 0, PANTS),
        ('split', 'Beach_Body', 0, SHIRT, sleeve),  # 어깨·상완·몸통 피부 → 반팔 티
    ]


RULES = {'cand2_casual': cand2_rules}
SLEEVE_AXIS = {'UpperArm.L': 'LowerArm.L', 'UpperArm.R': 'LowerArm.R'}


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
        self._mat_cache = {}

    def material(self, spec):
        name, color = spec
        if name in self._mat_cache:
            return self._mat_cache[name]
        mats = self.js['materials']
        base = next(m for m in mats if m.get('name') == 'Skin')
        m = json.loads(json.dumps(base))
        m['name'] = name
        if color.startswith('#'):
            m['pbrMetallicRoughness']['baseColorFactor'] = srgb_to_linear(color)
        else:  # 기존 재질 색 복사
            src = next(x for x in mats if x.get('name') == color)
            m['pbrMetallicRoughness']['baseColorFactor'] = list(src['pbrMetallicRoughness']['baseColorFactor'])
        mats.append(m)
        self._mat_cache[name] = len(mats) - 1
        return self._mat_cache[name]

    def mesh_prim(self, mesh_name, pi):
        for nd in self.nodes:
            if 'mesh' in nd and self.js['meshes'][nd['mesh']].get('name') == mesh_name:
                return self.js['meshes'][nd['mesh']], self.js['meshes'][nd['mesh']]['primitives'][pi]
        raise KeyError(mesh_name)

    def add_indices(self, values, component_type):
        fmt = {5121: 'B', 5123: 'H', 5125: 'I'}[component_type]
        size = {5121: 1, 5123: 2, 5125: 4}[component_type]
        pad = (4 - len(self.bin) % 4) % 4
        self.bin += b'\x00' * pad
        off = len(self.bin)
        self.bin += struct.pack('<' + fmt * len(values), *values)
        self.js['bufferViews'].append({'buffer': 0, 'byteOffset': off, 'byteLength': len(values) * size, 'target': 34963})
        self.js['accessors'].append({'bufferView': len(self.js['bufferViews']) - 1, 'componentType': component_type,
                                     'count': len(values), 'type': 'SCALAR', 'min': [min(values)], 'max': [max(values)]})
        return len(self.js['accessors']) - 1

    def tri_info(self, p):
        pos = accessor(self.js, self.bin, p['attributes']['POSITION'])
        J = accessor(self.js, self.bin, p['attributes']['JOINTS_0'])
        W = accessor(self.js, self.bin, p['attributes']['WEIGHTS_0'])
        idx = accessor(self.js, self.bin, p['indices'])
        dom = []
        for jj, ww in zip(J, W):
            k = max(range(4), key=lambda a: ww[a])
            dom.append(self.jname[int(jj[k])])
        tris = []
        for t in range(len(idx) // 3):
            vs = idx[3 * t:3 * t + 3]
            bones = {dom[v] for v in vs}
            # 상완 축 위치 비율: 어깨 관절(0) → 팔꿈치 관절(1)
            tval = None
            for ua, la in SLEEVE_AXIS.items():
                if ua in bones:
                    a, b_ = self.jpos[ua], self.jpos[la]
                    ax = tuple(b_[i] - a[i] for i in range(3))
                    L2 = sum(c * c for c in ax) or 1e-12
                    c = [sum(pos[v][i] for v in vs) / 3 for i in range(3)]
                    tval = sum((c[i] - a[i]) * ax[i] for i in range(3)) / L2
                    break
            tris.append({'bones': bones, 't': tval, 'idx': vs})
        return tris, idx, self.js['accessors'][p['indices']]['componentType']

    def apply(self, rules):
        for rule in rules:
            kind, mesh_name, pi, mat = rule[:4]
            mesh, p = self.mesh_prim(mesh_name, pi)
            mi = self.material(mat)
            if kind == 'material':
                p['material'] = mi
                continue
            pred = rule[4]
            tris, idx, ctype = self.tri_info(p)
            keep, move = [], []
            for tr in tris:
                (move if pred(tr) else keep).append(tr['idx'])
            if not move:
                print(f'  [{mesh_name}#{pi}] 술어 일치 삼각형 없음 — 건너뜀'); continue
            p['indices'] = self.add_indices([v for tr in keep for v in tr], ctype) if keep else p['indices']
            newp = json.loads(json.dumps(p))
            newp['material'] = mi
            newp['indices'] = self.add_indices([v for tr in move for v in tr], ctype)
            mesh['primitives'].append(newp)
            if not keep:
                mesh['primitives'].remove(p)
            print(f'  [{mesh_name}#{pi}] {len(move)} tris → {mat[0]}, {len(keep)} 유지')

    def save(self, path):
        self.js['buffers'][0]['byteLength'] = len(self.bin)
        jb = json.dumps(self.js, separators=(',', ':')).encode()
        jb += b' ' * ((4 - len(jb) % 4) % 4)
        bb = bytes(self.bin) + b'\x00' * ((4 - len(self.bin) % 4) % 4)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(jb) + 8 + len(bb)))
            f.write(struct.pack('<II', len(jb), JSON_CHUNK)); f.write(jb)
            f.write(struct.pack('<II', len(bb), BIN_CHUNK)); f.write(bb)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('dst'); ap.add_argument('--rules', required=True, choices=sorted(RULES))
    a = ap.parse_args()
    g = Glb(a.src)
    g.apply(RULES[a.rules]())
    g.save(a.dst)
    print('saved', a.dst)
