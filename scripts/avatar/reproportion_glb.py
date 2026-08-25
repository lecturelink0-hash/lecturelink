#!/usr/bin/env python3
"""CPX 환자 GLB 신체 비율 이식 도구 (의존성 없음).

기존 Quaternius 리그(CharacterArmature 23본)의 재질·애니메이션·얼굴 데칼 앵커를 그대로 두고,
목표 비율표(SPECS — poly.pizza CC0/CC-BY 인체 모델 계측값·표준 인체측정 기반)대로
  1) 바인드 포즈 관절 위치를 재배치하고 (관절 높이·좌우 폭)
  2) 본별 대각 스케일 A_i(길이축은 관절 목표에서 유도, 둘레축은 목표 둘레/실측 둘레)로
     정점을 스킨 가중치 블렌딩 워프: v' = Σ w_i (J_i' + A_i ⊙ (v - J_i))
  3) 법선(야코비안 역전치), 역바인드행렬, 노드 translation, 애니메이션 translation 트랙을 갱신한다.
회전 트랙은 손대지 않으므로 Idle 등 애니메이션은 그대로 재생된다. 머리 본은 항등(머리 크기 유지)이라
새 신장은 머리 크기 ÷ 머리 비율로 정해지고, 렌더러(Avatar3D)가 바운딩박스로 키를 정규화한다.

usage: python3 reproportion_glb.py src.glb dst.glb --spec adult_male [--report out.json]
"""
import argparse, json, math, struct, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from measure_glb import read_glb, accessor, minv, ibm_mats, collect, slice_profile, union_cover, NB  # noqa: E402

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942

# ── 목표 비율표 ────────────────────────────────────────────────
# 값은 모두 '피부 정수리(머리카락 제외)=1.0' 기준 신장 비율. y: 관절 높이, x: 좌우 반폭.
# head_scale: 머리 본 균일 배율(원본 머리가 스타일상 커서 성인은 0.85로 축소, 등신비 ≈7).
# w/d/h/len: 본 지배 정점군의 폭(x)/두께(z)/높이(y)/길이 목표.
# 출처: poly.pizza 계측(Character Base qbDLeTtb8K, Adventurer ZwF0K7WBmu, Woman wearing headset
# Qy6esq7e1z, Animated Woman 9kF7eTDbhO, Character_Man IE7rk47BHn) + Drillis–Contini 분절 비율.
SPECS = {
    'adult_male': {
        'head_scale': 0.85,
        'y': {'Head': .870, 'Neck': .840, 'Torso': .720, 'Abdomen': .620, 'Body': .545, 'Hips': .525,
              'LowerLeg': .285, 'Foot': .025, 'Shoulder': .800, 'UpperArm': .800},
        'x': {'UpperLeg': .055, 'Shoulder': .035, 'UpperArm': .125, 'LowerArm': .305, 'Fist': .445},
        'girth': {'Neck': {'w': .075, 'd': .085}, 'Torso': {'w': .175, 'd': .125}, 'Abdomen': {'w': .155, 'd': .115},
                  'Hips': {'w': .185, 'd': .125}, 'Body': {'w': .185, 'd': .125},
                  'UpperLeg': {'w': .085, 'd': .090}, 'LowerLeg': {'w': .060, 'd': .075},
                  'Foot': {'w': .055, 'd': .160, 'h': .050},
                  'Shoulder': {'h': .075, 'd': .075}, 'UpperArm': {'h': .060, 'd': .060}, 'LowerArm': {'h': .050, 'd': .050},
                  'Fist': {'h': .050, 'd': .030, 'len': .100}},
    },
    'adult_female': {
        'head_scale': 0.85,
        'y': {'Head': .865, 'Neck': .835, 'Torso': .715, 'Abdomen': .615, 'Body': .545, 'Hips': .525,
              'LowerLeg': .285, 'Foot': .025, 'Shoulder': .795, 'UpperArm': .795},
        'x': {'UpperLeg': .055, 'Shoulder': .030, 'UpperArm': .115, 'LowerArm': .290, 'Fist': .425},
        'girth': {'Neck': {'w': .065, 'd': .075}, 'Torso': {'w': .160, 'd': .120}, 'Abdomen': {'w': .140, 'd': .105},
                  'Hips': {'w': .195, 'd': .130}, 'Body': {'w': .195, 'd': .130},
                  'UpperLeg': {'w': .090, 'd': .095}, 'LowerLeg': {'w': .060, 'd': .070},
                  'Foot': {'w': .050, 'd': .150, 'h': .045},
                  'Shoulder': {'h': .065, 'd': .065}, 'UpperArm': {'h': .055, 'd': .055}, 'LowerArm': {'h': .045, 'd': .045},
                  'Fist': {'h': .045, 'd': .030, 'len': .095}},
    },
    # 학령기(≈7세, 6등신)
    'child': {
        'head_scale': 0.95,
        'y': {'Head': .840, 'Neck': .810, 'Torso': .700, 'Abdomen': .610, 'Body': .540, 'Hips': .520,
              'LowerLeg': .275, 'Foot': .025, 'Shoulder': .770, 'UpperArm': .770},
        'x': {'UpperLeg': .055, 'Shoulder': .033, 'UpperArm': .110, 'LowerArm': .270, 'Fist': .400},
        'girth': {'Neck': {'w': .080, 'd': .090}, 'Torso': {'w': .170, 'd': .130}, 'Abdomen': {'w': .160, 'd': .125},
                  'Hips': {'w': .180, 'd': .125}, 'Body': {'w': .180, 'd': .125},
                  'UpperLeg': {'w': .090, 'd': .095}, 'LowerLeg': {'w': .065, 'd': .075},
                  'Foot': {'w': .060, 'd': .160, 'h': .050},
                  'Shoulder': {'h': .075, 'd': .075}, 'UpperArm': {'h': .060, 'd': .060}, 'LowerArm': {'h': .050, 'd': .050},
                  'Fist': {'h': .050, 'd': .030, 'len': .100}},
    },
    # 걸음마기(18~24개월, ≈4등신)
    'infant': {
        'head_scale': 1.0,
        'y': {'Head': .760, 'Neck': .735, 'Torso': .645, 'Abdomen': .565, 'Body': .500, 'Hips': .480,
              'LowerLeg': .255, 'Foot': .030, 'Shoulder': .705, 'UpperArm': .705},
        'x': {'UpperLeg': .065, 'Shoulder': .040, 'UpperArm': .120, 'LowerArm': .265, 'Fist': .385},
        'girth': {'Neck': {'w': .100, 'd': .110}, 'Torso': {'w': .210, 'd': .165}, 'Abdomen': {'w': .215, 'd': .175},
                  'Hips': {'w': .215, 'd': .165}, 'Body': {'w': .215, 'd': .165},
                  'UpperLeg': {'w': .115, 'd': .120}, 'LowerLeg': {'w': .085, 'd': .095},
                  'Foot': {'w': .075, 'd': .170, 'h': .060},
                  'Shoulder': {'h': .090, 'd': .090}, 'UpperArm': {'h': .080, 'd': .080}, 'LowerArm': {'h': .070, 'd': .070},
                  'Fist': {'h': .065, 'd': .040, 'len': .110}},
    },
}

X, Y, Z = 0, 1, 2
CHAIN_AXIS = {  # 부모 본 → (자식 본, 길이축) : 자식 관절 목표로 부모의 길이축 스케일 결정
    'Hips': ('Abdomen', Y), 'Abdomen': ('Torso', Y), 'Torso': ('Neck', Y), 'Neck': ('Head', Y),
    'UpperArm': ('LowerArm', X), 'LowerArm': ('Fist', X), 'UpperLeg': ('LowerLeg', Y),
}
ORDER = ['Bone', 'Body', 'Hips', 'Abdomen', 'Torso', 'Neck', 'Head',
         'Shoulder.L', 'UpperArm.L', 'LowerArm.L', 'Fist.L', 'Shoulder.R', 'UpperArm.R', 'LowerArm.R', 'Fist.R',
         'UpperLeg.L', 'LowerLeg.L', 'UpperLeg.R', 'LowerLeg.R', 'Foot.L', 'Foot.R', 'PoleTarget.L', 'PoleTarget.R']


def side(name):
    return name[-2:] if name.endswith('.L') or name.endswith('.R') else ''


def base(name):
    return name[:-2] if side(name) else name


def rot_part(M):
    return [[M[r][c] for c in range(3)] for r in range(3)]


def mat3_t(R):
    return [[R[c][r] for c in range(3)] for r in range(3)]


def mat3_apply(R, v):
    return tuple(R[r][0] * v[0] + R[r][1] * v[1] + R[r][2] * v[2] for r in range(3))


def mat3_mul(A, B):
    return [[sum(A[i][k] * B[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def write_floats(bin_, js, acc_idx, rows):
    a = js['accessors'][acc_idx]
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[a['type']]
    assert a['componentType'] == 5126, 'float accessor only'
    bv = js['bufferViews'][a['bufferView']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride', n * 4)
    for i, row in enumerate(rows):
        struct.pack_into('<' + 'f' * n, bin_, off + i * stride, *row)
    if n in (3, 4) and 'min' in a:
        a['min'] = [min(r[k] for r in rows) for k in range(n)]
        a['max'] = [max(r[k] for r in rows) for k in range(n)]


def run(src, dst, spec_name, report_path=None):
    spec = SPECS[spec_name]
    js, bin_ = read_glb(src)
    bin_ = bytearray(bin_)
    nodes = js['nodes']
    sk = js['skins'][0]
    joint_nodes = sk['joints']
    jname = [nodes[j]['name'] for j in joint_nodes]
    # 메시 노드도 'Body'라는 이름이라 관절 노드 인덱스로만 매핑한다
    name2node = {nodes[j]['name']: j for j in joint_nodes}
    assert set(ORDER) == set(jname), (set(ORDER) ^ set(jname))
    IB = ibm_mats(js, bin_, sk)
    B = [minv(m) for m in IB]  # 바인드 월드 행렬
    J = {jname[k]: (B[k][0][3], B[k][1][3], B[k][2][3]) for k in range(len(jname))}
    R = {jname[k]: rot_part(B[k]) for k in range(len(jname))}
    parent = {}
    joint_set = set(joint_nodes)
    for i, nd in enumerate(nodes):
        for c in nd.get('children', []):
            if c in joint_set:
                parent[nodes[c]['name']] = nodes[i]['name'] if i in joint_set else None

    # ── 메시 수집: 프리미티브별 정점/가중치, 본 지배 정점군 실측 ──
    prims = []
    mesh_nodes = [i for i, nd in enumerate(nodes) if 'mesh' in nd and 'skin' in nd]
    skin_top = -1e9
    dom_pts = {n: [] for n in jname}
    for ni in mesh_nodes:
        for p in js['meshes'][nodes[ni]['mesh']]['primitives']:
            mat = js['materials'][p['material']].get('name', '') if 'material' in p else ''
            pos = accessor(js, bin_, p['attributes']['POSITION'])
            nrm = accessor(js, bin_, p['attributes']['NORMAL']) if 'NORMAL' in p['attributes'] else None
            jn = accessor(js, bin_, p['attributes']['JOINTS_0'])
            wt = accessor(js, bin_, p['attributes']['WEIGHTS_0'])
            prims.append((p, mat, pos, nrm, jn, wt))
            if mat != 'Hair':
                for v, jj, ww in zip(pos, jn, wt):
                    k = max(range(4), key=lambda a: ww[a])
                    dom_pts[jname[int(jj[k])]].append(v)
                    if mat == 'Skin' and v[1] > skin_top:
                        skin_top = v[1]
    H_old = skin_top - min(v[1] for pts in dom_pts.values() for v in pts)
    # 머리 본은 균일 스케일(head_scale, 턱=Head 관절 기준) → 새 신장 H 는 머리 크기로 결정
    hs = spec.get('head_scale', 1.0)
    H = hs * (skin_top - J['Head'][1]) / (1.0 - spec['y']['Head'])

    def ext(pts, axis):
        if not pts:
            return None
        return max(p[axis] for p in pts) - min(p[axis] for p in pts)

    # ── 몸통 체인 둘레: 바인드 포즈 단면 슬라이스(중심 통과 코어) 폭·두께 ──
    tris, _, _ = collect(js, bin_)
    tris = [t for t in tris]
    allp = [q for t in tris for q in t]
    ymin_all = min(q[1] for q in allp); ymax_all = max(q[1] for q in allp)
    Hs = ymax_all - ymin_all
    cx = (max(q[0] for q in allp) + min(q[0] for q in allp)) / 2
    segs = slice_profile(tris, 1, 0, 2, ymin_all, Hs)
    core_w = [0.0] * NB; core_d = [0.0] * NB
    for b in range(NB):
        u = union_cover(segs[b], cx) if segs[b] else None
        if u:
            core_w[b] = u[1] - u[0]; core_d[b] = u[3] - u[2]

    def band_girth(y0, y1):
        """[y0,y1] 구간 코어 폭/두께 중앙값 (T포즈 팔 병합 bin 은 최소폭의 1.3배 초과로 보고 제외)"""
        b0 = max(0, int((min(y0, y1) - ymin_all) / Hs * NB)); b1 = min(NB - 1, int((max(y0, y1) - ymin_all) / Hs * NB))
        ws = [(core_w[b], core_d[b]) for b in range(b0, b1 + 1) if core_w[b] > 0]
        if not ws:
            return None
        wmin = min(w for w, _ in ws)
        ws = [x for x in ws if x[0] <= wmin * 1.3]
        ws.sort()
        w = ws[len(ws) // 2][0]
        ds = sorted(d for _, d in ws)
        return w, ds[len(ds) // 2]

    TORSO_SPAN = {'Hips': ('Hips', 'Abdomen'), 'Abdomen': ('Abdomen', 'Torso'), 'Torso': ('Torso', 'Neck')}

    # ── 본별 스케일 A (name -> [sx,sy,sz]) : 둘레축 ──
    A = {n: [1.0, 1.0, 1.0] for n in jname}
    girth = spec['girth']
    old_girth = {}
    for n in jname:
        b = base(n)
        g = girth.get(b)
        if not g or b in ('Body', 'Foot'):
            continue
        if b in TORSO_SPAN:
            j0, j1 = TORSO_SPAN[b]
            y0, y1 = J[j0][1], J[j1][1]
            if b == 'Torso':  # 팔이 붙는 상부는 제외하고 하부 60% 만
                y1 = y0 + (y1 - y0) * 0.6
            bg = band_girth(y0, y1)
            if bg:
                A[n][X] = g['w'] * H / bg[0]; A[n][Z] = g['d'] * H / bg[1]
                old_girth[n] = {'w': round(bg[0] / H_old, 3), 'd': round(bg[1] / H_old, 3)}
            continue
        pts = dom_pts[n]
        for key, axis in (('w', X), ('h', Y), ('d', Z)):
            if key in g:
                e = ext(pts, axis)
                if e:
                    A[n][axis] = g[key] * H / e
                    old_girth.setdefault(n, {})[key] = round(e / H_old, 3)
        if 'len' in g and b == 'Fist':  # 손: 관절→손끝 길이(x)
            sgn = 1 if J[n][0] >= 0 else -1
            tip = max(sgn * p[0] for p in pts) - sgn * J[n][0]
            if tip > 0:
                A[n][X] = g['len'] * H / tip
    # 정점이 적어 실측이 불안정한 본은 인접 본 둘레를 상속
    A['Body'] = [A['Hips'][X], 1.0, A['Hips'][Z]]
    for s_ in ('.L', '.R'):
        A['Foot' + s_] = [A['LowerLeg' + s_][X], A['LowerLeg' + s_][X], A['LowerLeg' + s_][Z]]
    A['Head'] = [hs, hs, hs]

    # ── 관절 새 위치 + 길이축 스케일 (부모 확정 → 자식 목표로 부모 길이축 결정) ──
    ty, tx = spec['y'], spec['x']
    Jn = {'Bone': J['Bone']}

    def want(n):
        """자식 관절의 목표 절대좌표 (x: 반폭 목표, y: 높이 목표) — 없으면 None"""
        b = base(n)
        x = math.copysign(tx[b] * H, J[n][0]) if (b in tx and side(n)) else None
        y = ty[b] * H if b in ty else None
        return x, y

    def solve_len(pn, cn, axes):
        for axis in axes:
            w_ = want(cn)[axis]
            d_old = J[cn][axis] - J[pn][axis]
            if w_ is not None and abs(d_old) > 1e-6:
                A[pn][axis] = (w_ - Jn[pn][axis]) / d_old

    def mapped(pn, cn):
        d = sub(J[cn], J[pn])
        return add(Jn[pn], (A[pn][0] * d[0], A[pn][1] * d[1], A[pn][2] * d[2]))

    for n in ORDER[1:]:
        if n.startswith('PoleTarget'):
            f = H / H_old
            Jn[n] = (J[n][0] * f, J[n][1] * f, J[n][2] * f)
            continue
        if n.startswith('Foot'):
            Jn[n] = mapped('LowerLeg' + side(n), n)  # 발목은 정강이 체인 끝을 따라감
            continue
        b = base(n); s_ = side(n)
        if b == 'Body':  # 골반 루트: 부모(Bone)가 항등이라 목표 높이를 직접 배치 (x,z 는 신장비로)
            Jn[n] = (J[n][0] * H / H_old, ty['Body'] * H, J[n][2] * H / H_old)
        else:
            Jn[n] = mapped(parent[n], n)
        if b == 'Body':
            solve_len(n, 'Hips', [Y]); solve_len(n, 'UpperLeg.L', [X])
        elif b in ('Hips', 'Abdomen', 'Neck'):
            solve_len(n, CHAIN_AXIS[b][0], [Y])
        elif b == 'Torso':
            solve_len(n, 'Neck', [Y]); solve_len(n, 'Shoulder.L', [X])
        elif b == 'Shoulder':
            solve_len(n, 'UpperArm' + s_, [X, Y])
        elif b in ('UpperArm', 'LowerArm'):
            solve_len(n, CHAIN_AXIS[b][0] + s_, [X])
        elif b == 'UpperLeg':
            solve_len(n, 'LowerLeg' + s_, [Y])
        elif b == 'LowerLeg':
            solve_len(n, 'Foot' + s_, [Y])

    # ── 정점·법선 워프 ──
    for p, mat, pos, nrm, jn, wt in prims:
        new_pos, new_nrm = [], []
        for i, (v, jj, ww) in enumerate(zip(pos, jn, wt)):
            acc = [0.0, 0.0, 0.0]; L = [0.0, 0.0, 0.0]; tw = 0.0
            for a in range(4):
                w = ww[a]
                if w <= 0:
                    continue
                n = jname[int(jj[a])]
                d = sub(v, J[n]); s = A[n]
                for k in range(3):
                    acc[k] += w * (Jn[n][k] + s[k] * d[k]); L[k] += w * s[k]
                tw += w
            if tw <= 0:
                acc = list(v); L = [1.0, 1.0, 1.0]
            new_pos.append(tuple(acc))
            if nrm is not None:
                nn = [nrm[i][k] / (L[k] if abs(L[k]) > 1e-9 else 1.0) for k in range(3)]
                ln = math.sqrt(sum(c * c for c in nn)) or 1.0
                new_nrm.append(tuple(c / ln for c in nn))
        write_floats(bin_, js, p['attributes']['POSITION'], new_pos)
        if nrm is not None:
            write_floats(bin_, js, p['attributes']['NORMAL'], new_nrm)

    # ── 역바인드행렬 (회전 유지, 위치만 교체) ──
    new_ib = []
    for k, n in enumerate(jname):
        Bn = [row[:] for row in B[k]]
        for r in range(3):
            Bn[r][3] = Jn[n][r]
        ib = minv(Bn)
        new_ib.append(tuple(ib[r][c] for c in range(4) for r in range(4)))  # column-major
    write_floats(bin_, js, sk['inverseBindMatrices'], new_ib)

    # ── 노드 translation + 애니메이션 translation 트랙 ──
    # 부모 로컬 프레임 바인드 오프셋 t_bind = R_p^T (J_c - J_p); 델타는 S_local = R_p^T A_p R_p 로 스케일
    def local_frame(n):
        p = parent.get(n)
        if p not in J:
            return None
        Rp = R[p]; RpT = mat3_t(Rp)
        tb_old = mat3_apply(RpT, sub(J[n], J[p]))
        tb_new = mat3_apply(RpT, sub(Jn[n], Jn[p]))
        Ap = A[p]
        if p == 'Bone':  # 루트 직속(Body·Foot 등): 델타는 다리 길이 비율로 스케일 (Idle 크라우치 보존)
            Ap = [H / H_old, A['UpperLeg.L'][Y], H / H_old]
        S = mat3_mul(mat3_mul(RpT, [[Ap[0], 0, 0], [0, Ap[1], 0], [0, 0, Ap[2]]]), Rp)
        return tb_old, tb_new, S

    def remap_t(t, fr):
        tb_old, tb_new, S = fr
        return add(tb_new, mat3_apply(S, sub(t, tb_old)))

    frames = {}
    for n in jname:
        fr = local_frame(n)
        if fr is None:
            continue
        frames[n] = fr
        nd = nodes[name2node[n]]
        nd['translation'] = list(remap_t(tuple(nd.get('translation', [0, 0, 0])), fr))
    for an in js.get('animations', []):
        for ch in an['channels']:
            if ch['target']['path'] != 'translation':
                continue
            n = nodes[ch['target']['node']].get('name')
            if n not in frames:
                continue
            smp = an['samplers'][ch['sampler']]
            vals = accessor(js, bin_, smp['output'])
            write_floats(bin_, js, smp['output'], [remap_t(tuple(v), frames[n]) for v in vals])

    # ── 저장 ──
    gen = js.setdefault('asset', {}).get('generator', '')
    js['asset']['generator'] = (gen + ' + reproportion_glb.py').strip(' +')
    jb = json.dumps(js, separators=(',', ':')).encode()
    jb += b' ' * ((4 - len(jb) % 4) % 4)
    bb = bytes(bin_) + b'\x00' * ((4 - len(bin_) % 4) % 4)
    with open(dst, 'wb') as f:
        total = 12 + 8 + len(jb) + 8 + len(bb)
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(jb), JSON_CHUNK)); f.write(jb)
        f.write(struct.pack('<II', len(bb), BIN_CHUNK)); f.write(bb)

    rep = {
        'spec': spec_name, 'H_old_skin': round(H_old, 3), 'H_new_skin': round(H, 3),
        'joints_new_frac': {n: [round(Jn[n][0] / H, 3), round(Jn[n][1] / H, 3), round(Jn[n][2] / H, 3)] for n in ORDER},
        'bone_scale': {n: [round(s, 3) for s in A[n]] for n in ORDER},
        'old_girth_frac': old_girth,
    }
    if report_path:
        json.dump(rep, open(report_path, 'w'), ensure_ascii=False, indent=1)
    return rep


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('dst')
    ap.add_argument('--spec', required=True, choices=sorted(SPECS))
    ap.add_argument('--report')
    a = ap.parse_args()
    rep = run(a.src, a.dst, a.spec, a.report)
    print(json.dumps({'H_old': rep['H_old_skin'], 'H_new': rep['H_new_skin'], 'scales': rep['bone_scale']}, ensure_ascii=False))
