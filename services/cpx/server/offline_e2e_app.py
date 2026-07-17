"""Browser E2E app that keeps real API/storage paths but replaces LLM scoring.

Run only for local QA:
    venv/bin/uvicorn offline_e2e_app:app --port 8788
"""

import evaluate
import main


def _all_met_judgments(_api_key, rubric, _events, _context):
    items = {}
    for section in rubric.get('sections', []):
        for item in section.get('items', []):
            if item.get('type') == 'deduction':
                continue
            item_id = item.get('id')
            if item_id:
                items[item_id] = {
                    'satisfied': True,
                    'status': 'met',
                    'evidence': ['L001: deterministic local browser E2E'],
                    'confidence': 'high',
                }
    return {'items': items, 'violations': []}


main.GEMINI_API_KEY = 'offline-browser-e2e'
evaluate.extract_judgments = _all_met_judgments
app = main.app
