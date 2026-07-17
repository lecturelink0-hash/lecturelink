"""LectureLink 서버 프록시 인증 경계 회귀 테스트."""
import os

os.environ['REQUIRE_LECTURELINK_AUTH'] = 'true'
os.environ['CPX_PROXY_SHARED_SECRET'] = 'test-cpx-proxy-secret'

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402
import prompt as prompt_mod  # noqa: E402


client = TestClient(app)
HEADERS = {
    'x-cpx-proxy-secret': 'test-cpx-proxy-secret',
    'x-lecturelink-user-id': 'lecturelink-e2e-user',
}


def main():
    for path in ('/api/cases', '/api/exam-buttons'):
        denied = client.get(path)
        assert denied.status_code == 401, (path, denied.status_code, denied.text)

        allowed = client.get(path, headers=HEADERS)
        assert allowed.status_code == 200, (path, allowed.status_code, allowed.text)

    cases = client.get('/api/cases', headers=HEADERS).json()['cases']
    expected_cases = prompt_mod.list_cases()
    assert len(cases) == len(expected_cases)
    assert {case['id'] for case in cases} == {case['id'] for case in expected_cases}
    print(f'LectureLink 프록시 인증 경계·{len(cases)}개 증례 목록 통과')


if __name__ == '__main__':
    main()
