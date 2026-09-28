import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('acp', Path(__file__).parents[1] / 'dsh_acp.py')
acp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acp)

class ProtocolTests(unittest.TestCase):
    def client(self, root, messages):
        c = acp.Client.__new__(acp.Client)
        c.counter = 0
        c.denied = 0
        c.control_dir = None
        c.text = []
        c.errors = []
        c.event_file = root / 'events.jsonl'
        c.process = type('Fake', (), {'stdin': io.StringIO(), 'stdout': io.StringIO('\n'.join(json.dumps(m) for m in messages))})()
        return c

    def test_permission_is_rejected_and_recorded_without_auto_approval(self):
        with tempfile.TemporaryDirectory() as d:
            c = self.client(Path(d), [
                {'id': 99, 'method': 'session/request_permission', 'params': {'sessionId': 's', 'options': [{'optionId': 'yes', 'kind': 'allow_once'}]}},
                {'method': 'session/update', 'params': {'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'permission refused'}}}},
                {'id': 1, 'result': {'stopReason': 'end_turn'}}])
            self.assertEqual(c.call('session/prompt', {})['stopReason'], 'end_turn')
            sent = [json.loads(s) for s in c.process.stdin.getvalue().splitlines()]
            self.assertEqual(sent[1]['result']['outcome']['outcome'], 'cancelled')
            self.assertEqual(c.denied, 1)
            self.assertIn('permission_denied', c.event_file.read_text())
            self.assertEqual(c.text, ['permission refused'])

    def test_failed_resume_never_creates_new_session(self):
        with tempfile.TemporaryDirectory() as d:
            c = self.client(Path(d), [{'id': 1, 'error': {'code': -32602, 'message': 'session is not resumable'}}])
            with self.assertRaisesRegex(RuntimeError, 'not resumable'):
                c.call('session/resume', {'sessionId': 'missing'})
            self.assertNotIn('session/new', c.process.stdin.getvalue())

    def test_unexpected_eof_is_failure(self):
        with tempfile.TemporaryDirectory() as d:
            c = self.client(Path(d), [])
            with self.assertRaisesRegex(RuntimeError, 'disconnected'):
                c.call('session/prompt', {})

if __name__ == '__main__':
    unittest.main()
