"""Offline API lifecycle smoke test for every CPX case."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

os.environ["REQUIRE_LECTURELINK_AUTH"] = "true"
os.environ["CPX_PROXY_SHARED_SECRET"] = "offline-api-test-secret"

import db  # noqa: E402
import evaluate  # noqa: E402
import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


HEADERS = {
    "x-cpx-proxy-secret": "offline-api-test-secret",
    "x-lecturelink-user-id": "all-cases-api-tester",
}
OTHER_USER_HEADERS = {
    "x-cpx-proxy-secret": "offline-api-test-secret",
    "x-lecturelink-user-id": "other-api-tester",
}


def fake_extract_judgments(*args, **kwargs):
    rubric = kwargs.get("rubric")
    if rubric is None and len(args) >= 2:
        rubric = args[1]
    items = {}
    for section in (rubric or {}).get("sections", []):
        for item in section.get("items", []):
            if item.get("type") == "deduction":
                continue
            item_id = item.get("id")
            if item_id:
                items[item_id] = {
                    "satisfied": True,
                    "status": "met",
                    "evidence": ["L001: offline deterministic API lifecycle test"],
                    "confidence": "high",
                }
    return {"items": items, "violations": []}


def expect_ok(response, label: str):
    assert response.status_code == 200, (
        f"{label}: HTTP {response.status_code}: {response.text[:500]}"
    )
    return response.json()


def run() -> None:
    original_extract = evaluate.extract_judgments
    original_api_key = main.GEMINI_API_KEY

    with tempfile.TemporaryDirectory(prefix="cpx-all-cases-api-") as tmpdir:
        db.DB_PATH = Path(tmpdir) / "cpx.sqlite3"
        main.GEMINI_API_KEY = "offline-e2e"
        evaluate.extract_judgments = fake_extract_judgments
        try:
            with TestClient(main.app) as client:
                case_payload = expect_ok(client.get("/api/cases", headers=HEADERS), "case list")
                cases = case_payload["cases"]
                assert len(cases) == 197, f"expected 197 cases, got {len(cases)}"

                first_session_id = None
                for index, case in enumerate(cases, start=1):
                    case_id = case["id"]
                    session = expect_ok(
                        client.post("/api/sessions", headers=HEADERS, json={"caseId": case_id}),
                        f"{case_id}: create session",
                    )
                    session_id = session["sessionId"]
                    first_session_id = first_session_id or session_id

                    events = [
                        {"role": "student", "text": "안녕하세요. 불편한 점을 말씀해 주세요.", "tOffsetMs": 0},
                        {"role": "patient", "text": "네, 증상 때문에 방문했습니다.", "tOffsetMs": 1000},
                        {"role": "student", "text": "필요한 문진과 신체진찰을 시행하겠습니다.", "tOffsetMs": 2000},
                    ]
                    expect_ok(
                        client.post(
                            f"/api/sessions/{session_id}/events",
                            headers=HEADERS,
                            json=events,
                        ),
                        f"{case_id}: append transcript events",
                    )

                    button_payload = expect_ok(
                        client.get("/api/exam-buttons", headers=HEADERS, params={"caseId": case_id}),
                        f"{case_id}: exam buttons",
                    )
                    buttons = button_payload["buttons"]
                    for button in buttons:
                        expect_ok(
                            client.post(
                                f"/api/sessions/{session_id}/exam",
                                headers=HEADERS,
                                json={"buttonId": button["id"], "tOffsetMs": 3000},
                            ),
                            f"{case_id}: exam {button['id']}",
                        )

                    expect_ok(
                        client.post(f"/api/sessions/{session_id}/end", headers=HEADERS),
                        f"{case_id}: end session",
                    )
                    result = expect_ok(
                        client.post(f"/api/sessions/{session_id}/evaluate", headers=HEADERS),
                        f"{case_id}: evaluate",
                    )
                    assert result["totalScore"] == 100, (
                        f"{case_id}: expected 100, got {result['totalScore']}"
                    )
                    cached = expect_ok(
                        client.post(f"/api/sessions/{session_id}/evaluate", headers=HEADERS),
                        f"{case_id}: cached evaluate",
                    )
                    assert cached == result, f"{case_id}: cached result changed"

                    transcript = expect_ok(
                        client.get(f"/api/sessions/{session_id}/transcript", headers=HEADERS),
                        f"{case_id}: transcript",
                    )
                    assert transcript.get("session", {}).get("result") is not None, (
                        f"{case_id}: result not saved"
                    )
                    assert len(transcript.get("events", [])) >= 3, (
                        f"{case_id}: transcript events missing"
                    )
                    if index % 25 == 0 or index == len(cases):
                        print(f"API lifecycle passed: {index}/{len(cases)}")

                assert first_session_id is not None
                forbidden = client.get(
                    f"/api/sessions/{first_session_id}/transcript",
                    headers=OTHER_USER_HEADERS,
                )
                assert forbidden.status_code in (403, 404), (
                    "cross-user transcript access should be denied, "
                    f"got {forbidden.status_code}"
                )
        finally:
            evaluate.extract_judgments = original_extract
            main.GEMINI_API_KEY = original_api_key

    print("All 197 cases passed the offline API lifecycle test.")


if __name__ == "__main__":
    run()
