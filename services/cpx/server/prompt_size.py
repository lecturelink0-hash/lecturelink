"""환자 시스템 프롬프트 크기 측정 — 축약 작업의 before/after를 수치로 확정한다.

프롬프트는 세션당 한 번이 아니라 턴마다 재전송되는 컨텍스트의 일부라, 길이가 곧 원가다
(2026-08-12 실측: CPX 1회 202원 중 프롬프트 재전송이 37%). 축약할 때마다 눈대중으로
"줄어든 것 같다"고 하지 않도록 측정기를 남긴다.

실행:
    python prompt_size.py                 # 현재 작업본의 크기·구성
    python prompt_size.py <git-ref>       # 해당 커밋 대비 증감 (예: python prompt_size.py 04db02a)
"""
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

import prompt

REPO_ROOT = Path(__file__).resolve().parents[3]
PROMPT_REL = 'services/cpx/server/prompt.py'
COMMON_REL = 'services/cpx/data/cpx/common/ai_patient_common_prompt.md'


def sizes(module, common_path: Path) -> list[int]:
    """모든 증례의 시스템 프롬프트 길이. 데이터 경로는 항상 현재 작업본을 쓴다
    (비교 대상은 프롬프트 문구이지 증례 데이터가 아니다)."""
    module.DATA_DIR = prompt.DATA_DIR
    module.CASES_ROOT = prompt.CASES_ROOT
    module.COMMON_PROMPT_PATH = common_path
    if hasattr(prompt, 'LOW_COMPLIANCE_PATH'):
        module.LOW_COMPLIANCE_PATH = prompt.LOW_COMPLIANCE_PATH
    return [len(module.build_system_instruction(m['id'])) for m in prompt.list_cases()]


def composition() -> list[tuple[str, float]]:
    """현재 작업본의 구성 비율 — 어디를 줄여야 효과가 큰지 판단용."""
    common_len = len(prompt.COMMON_PROMPT_PATH.read_text(encoding='utf-8').strip())
    rule_ctx, rule_blocks, voice, total = [], [], [], []
    for meta in prompt.list_cases():
        s = prompt.build_system_instruction(meta['id'])
        total.append(len(s))
        rule_ctx.append(len(s.split('[ruleContext]\n', 1)[1].split('\n\n우선순위:', 1)[0]))
        rule_blocks.append(len(s.split('\n\n우선순위:', 1)[1]))
        voice.append(len(s.split('[음성·말투 연기', 1)[1].split('\n\n[ruleContext]', 1)[0]))
    mean_total = statistics.mean(total)
    return [
        ('공통 프롬프트(md)', common_len),
        ('규칙 블록(prompt.py)', statistics.mean(rule_blocks)),
        ('ruleContext(증례 JSON)', statistics.mean(rule_ctx)),
        ('음성·말투', statistics.mean(voice)),
    ], mean_total


def _load_ref(ref: str, tmp: Path):
    """지정 커밋의 prompt.py를 임시 모듈로 적재한다."""
    for rel, name in ((PROMPT_REL, 'ref_prompt.py'), (COMMON_REL, 'ref_common.md')):
        blob = subprocess.run(['git', 'show', f'{ref}:{rel}'], cwd=REPO_ROOT,
                              capture_output=True, text=True, check=True).stdout
        (tmp / name).write_text(blob, encoding='utf-8')
    sys.path.insert(0, str(tmp))
    import importlib
    return importlib.import_module('ref_prompt'), tmp / 'ref_common.md'


def run(ref: str | None = None) -> int:
    now = sizes(prompt, prompt.COMMON_PROMPT_PATH)
    parts, mean_total = composition()
    print(f'증례 {len(now)}개 · 시스템 프롬프트 평균 {statistics.mean(now):,.0f}자 '
          f'(최소 {min(now):,} · 최대 {max(now):,})\n')
    for label, size in parts:
        print(f'  {label:24s} {size:7,.0f}자  {size / mean_total * 100:5.1f}%')

    if ref:
        with tempfile.TemporaryDirectory() as td:
            module, common = _load_ref(ref, Path(td))
            before = statistics.mean(sizes(module, common))
        after = statistics.mean(now)
        delta = after - before
        print(f'\n{ref} 대비: {before:,.0f}자 → {after:,.0f}자  '
              f'({delta:+,.0f}자, {delta / before * 100:+.1f}%)')
    return 0


if __name__ == '__main__':
    sys.exit(run(sys.argv[1] if len(sys.argv) > 1 else None))
