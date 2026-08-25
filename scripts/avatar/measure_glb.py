#!/usr/bin/env python3
"""GLB 인체 비율 계측기 (의존성 없음, 슬라이스 기반).

각 높이 평면과 삼각형을 교차시켜 단면 선분을 얻고, 몸 중심(x=cx)을 지나는 선분 합집합(코어)을
몸통/머리/다리 실루엣으로 삼는다 → T/A 포즈 팔의 영향을 배제.
리그 모델은 바인드 포즈(원본 POSITION) 기준, 관절 위치는 IBM 역행렬로 계산.
"""
import json, struct, sys

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
CT = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
BIND_POSE = True
NB = 100


def read_glb(path):
    with open(path, 'rb') as f:
        magic, version, total = struct.unpack('<III', f.read(12))
        assert magic == 0x46546C67
        chunks = []
        while f.tell() < total:
            ln, ty = struct.unpack('<II', f.read(8))
            chunks.append((ty, f.read(ln)))
    js = json.loads(chunks[0][1])
    bins = [c[1] for c in chunks if c[0] == BIN_CHUNK]
    return js, (bins[0] if bins else b'')


def accessor(js, bin_, idx):
    a = js['accessors'][idx]
    n = NC[a['type']]
    fmt, sz = CT[a['componentType']]
    cnt = a['count']
    if 'bufferView' not in a:
        return [tuple([0.0] * n) if n > 1 else 0 for _ in range(cnt)]
    bv = js['bufferViews'][a['bufferView']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride', n * sz)
    out = []
    norm = a.get('normalized', False)
    for i in range(cnt):
        vals = struct.unpack_from('<' + fmt * n, bin_, off + i * stride)
        if norm:
            m = {'B': 255.0, 'H': 65535.0, 'b': 127.0, 'h': 32767.0}[fmt]
            vals = tuple(v / m for v in vals)
        out.append(vals if n > 1 else vals[0])
    return out


def quat_to_mat(q):
    x, y, z, w = q
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
        [0, 0, 0, 1]]


def mmul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def minv(m):
    n = 4
    A = [row[:] + [1.0 if i == j else 0.0 for j in range(n)] for i, row in enumerate(m)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(A[r][c]))
        A[c], A[p] = A[p], A[c]
        d = A[c][c]
        if abs(d) < 1e-12:
            return None
        A[c] = [v / d for v in A[c]]
        for r in range(n):
            if r != c and A[r][c] != 0:
                f = A[r][c]
                A[r] = [a - f * b for a, b in zip(A[r], A[c])]
    return [row[n:] for row in A]


def node_local(nd):
    if 'matrix' in nd:
        m = nd['matrix']
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    t = nd.get('translation', [0, 0, 0]); r = nd.get('rotation', [0, 0, 0, 1]); s = nd.get('scale', [1, 1, 1])
    M = quat_to_mat(r)
    for i in range(3):
        for j in range(3):
            M[i][j] *= s[j]
    for i in range(3):
        M[i][3] = t[i]
    return M


def apply(M, v):
    x, y, z = v
    return (M[0][0] * x + M[0][1] * y + M[0][2] * z + M[0][3],
            M[1][0] * x + M[1][1] * y + M[1][2] * z + M[1][3],
            M[2][0] * x + M[2][1] * y + M[2][2] * z + M[2][3])


def world_matrices(js):
    nodes = js.get('nodes', [])
    parent = {}
    for i, nd in enumerate(nodes):
        for c in nd.get('children', []):
            parent[c] = i
    W = [None] * len(nodes)

    def wm(i):
        if W[i] is None:
            L = node_local(nodes[i])
            W[i] = mmul(wm(parent[i]), L) if i in parent else L
        return W[i]
    for i in range(len(nodes)):
        wm(i)
    return W


def ibm_mats(js, bin_, sk):
    if 'inverseBindMatrices' not in sk:
        return None
    raw = accessor(js, bin_, sk['inverseBindMatrices'])
    return [[[m[c * 4 + r] for c in range(4)] for r in range(4)] for m in raw]


def collect(js, bin_):
    nodes = js.get('nodes', [])
    W = world_matrices(js)
    tris = []
    tri_total = 0
    for ni, nd in enumerate(nodes):
        if 'mesh' not in nd:
            continue
        mesh = js['meshes'][nd['mesh']]
        skinned = 'skin' in nd
        for p in mesh['primitives']:
            if 'POSITION' not in p['attributes'] or p.get('mode', 4) != 4:
                continue
            pos = accessor(js, bin_, p['attributes']['POSITION'])
            if skinned and BIND_POSE:
                pts = pos
            elif skinned:
                sk = js['skins'][nd['skin']]
                ib = ibm_mats(js, bin_, sk)
                JM = [mmul(W[j], ib[k]) if ib else W[j] for k, j in enumerate(sk['joints'])]
                jnt = accessor(js, bin_, p['attributes']['JOINTS_0'])
                wgt = accessor(js, bin_, p['attributes']['WEIGHTS_0'])
                pts = []
                for v, jj, ww in zip(pos, jnt, wgt):
                    x = y = z = 0.0; tw = 0.0
                    for a in range(4):
                        w = ww[a]
                        if w <= 0:
                            continue
                        px, py, pz = apply(JM[int(jj[a])], v)
                        x += w * px; y += w * py; z += w * pz; tw += w
                    pts.append((x, y, z) if tw > 0 else v)
            else:
                M = W[ni]
                pts = [apply(M, v) for v in pos]
            idx = accessor(js, bin_, p['indices']) if 'indices' in p else list(range(len(pts)))
            n = len(idx) // 3
            tri_total += n
            step = max(1, n // 60000)
            for t in range(0, n, step):
                tris.append((pts[idx[3 * t]], pts[idx[3 * t + 1]], pts[idx[3 * t + 2]]))
    joints = {}
    for sk in js.get('skins', []):
        ib = ibm_mats(js, bin_, sk)
        for k, j in enumerate(sk['joints']):
            nm = nodes[j].get('name', f'n{j}')
            M = W[j]
            if BIND_POSE and ib:
                B = minv(ib[k])
                if B:
                    M = B
            joints[nm] = (M[0][3], M[1][3], M[2][3])
    return tris, joints, tri_total


def slice_profile(tris, up, lat, dep, bot, H):
    segs = [[] for _ in range(NB)]
    for tri in tris:
        ys = [p[up] for p in tri]
        ymin, ymax = min(ys), max(ys)
        b0 = max(0, int((ymin - bot) / H * NB))
        b1 = min(NB - 1, int((ymax - bot) / H * NB))
        for b in range(b0, b1 + 1):
            y = bot + (b + 0.5) * H / NB
            if y < ymin or y > ymax:
                continue
            pts = []
            for i in range(3):
                pa, pb = tri[i], tri[(i + 1) % 3]
                ya, yb = pa[up], pb[up]
                if (ya - y) * (yb - y) > 0 or ya == yb:
                    continue
                f = (y - ya) / (yb - ya)
                pts.append((pa[lat] + (pb[lat] - pa[lat]) * f, pa[dep] + (pb[dep] - pa[dep]) * f))
            if len(pts) < 2:
                continue
            xs = [q[0] for q in pts]; zs = [q[1] for q in pts]
            segs[b].append((min(xs), max(xs), min(zs), max(zs)))
    return segs


def union_cover(segs, cx):
    segs = sorted(segs)
    cur = None
    for x0, x1, z0, z1 in segs:
        if cur is None or x0 > cur[1] + 1e-6:
            if cur is not None and cur[0] <= cx <= cur[1]:
                return cur
            cur = [x0, x1, z0, z1]
        else:
            cur[1] = max(cur[1], x1); cur[2] = min(cur[2], z0); cur[3] = max(cur[3], z1)
    if cur is not None and cur[0] <= cx <= cur[1]:
        return cur
    return None


def measure(path):
    js, bin_ = read_glb(path)
    tris, joints, tri_total = collect(js, bin_)
    if not tris:
        return None
    allp = [p for t in tris for p in t]
    mins = [min(p[i] for p in allp) for i in range(3)]
    maxs = [max(p[i] for p in allp) for i in range(3)]
    ext = [maxs[i] - mins[i] for i in range(3)]
    up = 2 if (ext[2] > ext[1] * 1.3 and ext[2] >= ext[0]) else 1
    lat = 0
    dep = 3 - up - lat
    H = ext[up]
    bot, top = mins[up], maxs[up]
    cx = (maxs[lat] + mins[lat]) / 2
    segs = slice_profile(tris, up, lat, dep, bot, H)
    core_w = [0.0] * NB; core_d = [0.0] * NB; covered = [False] * NB; full_w = [0.0] * NB
    for b in range(NB):
        if not segs[b]:
            continue
        full_w[b] = max(s[1] for s in segs[b]) - min(s[0] for s in segs[b])
        u = union_cover(segs[b], cx)
        if u:
            covered[b] = True; core_w[b] = u[1] - u[0]; core_d[b] = u[3] - u[2]
    lo, hi = int(NB * 0.60), int(NB * 0.94)
    cand = [(core_w[i], i) for i in range(lo, hi) if covered[i] and core_w[i] > 0]
    neck_i = min(cand)[1] if cand else hi
    neck_y = bot + (neck_i + 0.5) * H / NB
    head_h = top - neck_y
    head_w = max([core_w[i] for i in range(neck_i, NB)] or [0])
    head_d = max([core_d[i] for i in range(neck_i, NB)] or [0])
    crotch_i = None
    for i in range(int(NB * 0.62), -1, -1):
        if not covered[i] and full_w[i] > 0:
            crotch_i = i; break
    legs_split = crotch_i is not None and crotch_i > int(NB * 0.15)
    crotch_y = bot + (crotch_i + 1) * H / NB if legs_split else None
    lname = {k.lower(): k for k in joints}

    def find(*keys, side=None):
        for k in lname:
            if any(key in k for key in keys):
                if side is None:
                    return joints[lname[k]]
                if side == 'l' and (k.endswith('.l') or k.endswith('_l') or 'left' in k or k.startswith('l_') or k.startswith('left')):
                    return joints[lname[k]]
                if side == 'r' and (k.endswith('.r') or k.endswith('_r') or 'right' in k or k.startswith('r_') or k.startswith('right')):
                    return joints[lname[k]]
        return None
    hips_j = find('hips', 'hip', 'pelvis')
    head_j = find('head')
    neck_j = find('neck')
    shl = find('upperarm', 'upper_arm', 'shoulder', 'clavicle', 'arm', side='l')
    shr = find('upperarm', 'upper_arm', 'shoulder', 'clavicle', 'arm', side='r')
    sh_w = abs(shl[lat] - shr[lat]) if (shl and shr) else None
    if crotch_y is None and hips_j:
        crotch_y = hips_j[up] - 0.02 * H
    leg_frac = (crotch_y - bot) / H if crotch_y is not None else None
    ci = int((crotch_y - bot) / H * NB) if crotch_y is not None else int(NB * 0.45)
    c0, c1 = max(0, neck_i - int(NB * 0.22)), max(1, neck_i - int(NB * 0.10))
    cd = sorted(core_d[c0:c1]); cw = sorted(core_w[c0:c1])
    chest_d = cd[len(cd) // 2] if cd else 0; chest_w = cw[len(cw) // 2] if cw else 0
    ab_i = (neck_i + ci) // 2
    abd_d = core_d[ab_i]; abd_w = core_w[ab_i]
    h0, h1 = min(NB - 1, ci + int(NB * 0.03)), min(NB, ci + int(NB * 0.10))
    hip_w = max(core_w[h0:h1] or [0])
    s0, s1 = max(0, neck_i - int(NB * 0.12)), max(1, neck_i - int(NB * 0.03))
    sil_sh_w = max(full_w[s0:s1] or [0])
    return dict(
        H=round(H, 3), tri=tri_total, up='z' if up == 2 else 'y',
        head_frac=round(head_h / H, 3), heads_tall=round(H / head_h, 2) if head_h else None,
        head_w=round(head_w / H, 3), head_d=round(head_d / H, 3),
        leg_frac=round(leg_frac, 3) if leg_frac is not None else None, legs_split=legs_split,
        chest_d=round(chest_d / H, 3), chest_w=round(chest_w / H, 3),
        abd_d=round(abd_d / H, 3), abd_w=round(abd_w / H, 3), hip_w=round(hip_w / H, 3),
        shoulder_rig=round(sh_w / H, 3) if sh_w else None, shoulder_sil=round(sil_sh_w / H, 3),
        neck_frac=round((neck_y - bot) / H, 3),
        head_j=round((head_j[up] - bot) / H, 3) if head_j else None,
        neck_j=round((neck_j[up] - bot) / H, 3) if neck_j else None,
        hips_j=round((hips_j[up] - bot) / H, 3) if hips_j else None,
        joints=len(joints), joint_names=sorted(joints)[:60], anims=len(js.get('animations', [])),
        anim_names=[a.get('name', '') for a in js.get('animations', [])][:20],
        materials=[m.get('name', '') for m in js.get('materials', [])][:12],
        textured=bool(js.get('textures')), meshes=len(js.get('meshes', [])),
        core_profile=[round(w / H, 2) for w in core_w[::5]],
    )


if __name__ == '__main__':
    for p in sys.argv[1:]:
        try:
            r = measure(p)
        except Exception as e:
            import traceback; r = {'error': repr(e), 'tb': traceback.format_exc()[-300:]}
        print(json.dumps({'file': p, **(r or {})}, ensure_ascii=False))
