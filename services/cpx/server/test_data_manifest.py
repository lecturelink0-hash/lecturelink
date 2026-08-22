"""배포 이미지에 실리는 데이터가 런타임이 실제로 읽는 것뿐인가 (2026-08-22 진단).

data/cpx 에는 런타임이 읽는 파일과 콘텐츠 작성·검수용 원자료가 섞여 있다. 어느 쪽인지
파일 이름으로는 구분되지 않아서, 루브릭을 고칠 때 살아 있는 파일이 어느 것인지 헷갈린다.
2026-08-18 감사가 common/ 의 원자료 10개를 .dockerignore 로 뺐지만 scenario_rules/ 3개가
남아 있었다.

이 테스트가 그 구분을 코드로 고정한다. **런타임 적재 목록은 추측이 아니라 모듈 상수에서
끌어온다** — 로더가 바뀌면 이 목록도 따라 바뀌므로 목록이 낡을 수 없다.
새 데이터 파일을 넣으면 둘 중 하나를 반드시 하게 된다: 코드가 읽게 하거나, 이미지에서 빼거나.
"""
from __future__ import annotations

from pathlib import Path

import evaluate
import prompt

DATA_ROOT = Path(prompt.DATA_DIR).resolve()          # services/cpx/data/cpx
SERVICE_ROOT = DATA_ROOT.parent.parent               # services/cpx — .dockerignore 경로의 기준
DOCKERIGNORE = SERVICE_ROOT / '.dockerignore'


def runtime_loaded_files() -> set[Path]:
    """런타임이 실제로 여는 파일 — 로더가 쓰는 상수에서 그대로 끌어온다."""
    loaded = {
        Path(prompt.COMMON_PROMPT_PATH).resolve(),
        Path(prompt.LOW_COMPLIANCE_PATH).resolve(),
    }
    loaded |= {
        (Path(evaluate.COMMON_DIR) / fname).resolve()
        for fname in evaluate.RUBRIC_BY_CATEGORY.values()
    }
    loaded |= {Path(p).resolve() for p in prompt._case_files()}
    return loaded


def dockerignore_patterns() -> list[str]:
    lines = DOCKERIGNORE.read_text(encoding='utf-8').splitlines()
    return [ln.strip() for ln in lines if ln.strip() and not ln.strip().startswith(('#', '!'))]


def is_excluded(rel: str, patterns: list[str]) -> bool:
    return any(rel == p or (p.endswith('/') and rel.startswith(p)) for p in patterns)


def test_every_shipped_data_file_is_read_by_the_runtime() -> None:
    loaded = runtime_loaded_files()
    patterns = dockerignore_patterns()
    stowaways = []
    for path in sorted(DATA_ROOT.rglob('*')):
        if not path.is_file() or path.name == '.DS_Store':
            continue
        resolved = path.resolve()
        if resolved in loaded:
            continue
        rel = resolved.relative_to(SERVICE_ROOT).as_posix()
        if not is_excluded(rel, patterns):
            stowaways.append(rel)
    assert not stowaways, (
        '어떤 런타임 코드도 읽지 않는 데이터가 배포 이미지에 실린다.\n'
        '코드가 읽게 하거나, services/cpx/.dockerignore 에 추가하라:\n'
        + '\n'.join(stowaways[:20])
    )
    total = sum(1 for p in DATA_ROOT.rglob('*') if p.is_file())
    print(f'  데이터 {total}개 중 런타임 적재 {len(loaded)}개 · 나머지는 이미지 제외 확인')


def test_excluded_files_are_not_secretly_loaded() -> None:
    """역방향 — 제외 목록에 올린 파일을 코드가 읽게 되면 운영에서 FileNotFoundError 가 난다.

    이미지에 없는 파일을 로더가 열면 컨테이너 안에서만 터진다(로컬 테스트는 통과한다).
    가장 늦게 발견되는 종류의 고장이라 여기서 미리 막는다.
    """
    loaded = runtime_loaded_files()
    patterns = dockerignore_patterns()
    broken = [
        p.resolve().relative_to(SERVICE_ROOT).as_posix()
        for p in loaded
        if is_excluded(p.resolve().relative_to(SERVICE_ROOT).as_posix(), patterns)
    ]
    assert not broken, (
        '런타임이 읽는 파일이 .dockerignore 로 제외돼 있다 — 컨테이너에서만 터진다:\n'
        + '\n'.join(broken)
    )
    print(f'  런타임 적재 {len(loaded)}개 전부 이미지에 포함 확인')


if __name__ == '__main__':
    test_every_shipped_data_file_is_read_by_the_runtime()
    test_excluded_files_are_not_secretly_loaded()
    print('데이터 매니페스트 회귀 테스트 통과')
