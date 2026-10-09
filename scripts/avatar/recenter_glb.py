#!/usr/bin/env python3
"""GLB 원점 보정: 바운딩 박스의 x·z 중심을 0, 최저 y를 0으로 옮긴다 (씬 루트 노드 translation 조정).

Avatar3D 는 모델 원점이 발 아래 중심에 있다고 가정하므로(눕기 시 x·z 오프셋이 그대로 침대 위치 어긋남),
원점이 치우친 poly.pizza 원형 모델은 이 도구로 한 번 보정한다. 스킨 메시는 기본 포즈로 CPU 스키닝해 계측.

usage: python3 recenter_glb.py in.glb out.glb
"""
import json, struct, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import measure_glb  # noqa: E402

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def main(src, dst):
    measure_glb.BIND_POSE = False  # 기본 포즈 실측
    js, bin_ = measure_glb.read_glb(src)
    tris, _, _ = measure_glb.collect(js, bin_)
    pts = [p for t in tris for p in t]
    mins = [min(p[i] for p in pts) for i in range(3)]
    maxs = [max(p[i] for p in pts) for i in range(3)]
    dx = -(mins[0] + maxs[0]) / 2
    dy = -mins[1]
    dz = -(mins[2] + maxs[2]) / 2
    for r in js['scenes'][0]['nodes']:
        nd = js['nodes'][r]
        if 'matrix' in nd:
            m = nd['matrix']; m[12] += dx; m[13] += dy; m[14] += dz
        else:
            t = nd.get('translation', [0, 0, 0])
            nd['translation'] = [t[0] + dx, t[1] + dy, t[2] + dz]
    jb = json.dumps(js, separators=(',', ':')).encode()
    jb += b' ' * ((4 - len(jb) % 4) % 4)
    bb = bytes(bin_) + b'\x00' * ((4 - len(bin_) % 4) % 4)
    with open(dst, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(jb) + 8 + len(bb)))
        f.write(struct.pack('<II', len(jb), JSON_CHUNK)); f.write(jb)
        f.write(struct.pack('<II', len(bb), BIN_CHUNK)); f.write(bb)
    print(json.dumps({'shift': [round(dx, 4), round(dy, 4), round(dz, 4)], 'bbox_min': [round(v, 3) for v in mins], 'bbox_max': [round(v, 3) for v in maxs]}))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
