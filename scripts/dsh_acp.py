"""Bounded ACP client. The parent owns provider routing and process-group timeout."""
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path


class Client:
    def __init__(self, command, event_file):
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, bufsize=1)
        self.counter = 0
        self.event_file = event_file
        self.control_dir = Path(os.environ['WORKBENCH_DSH_CONTROL_DIR']) if os.environ.get('WORKBENCH_DSH_CONTROL_DIR') else None
        self.denied = 0
        self.text = []
        self.errors = []
        self.reader = threading.Thread(target=self.read_errors, daemon=True)
        self.reader.start()

    def read_errors(self):
        for line in self.process.stderr:
            self.errors.append(line)

    def record(self, value):
        with self.event_file.open('a') as f:
            f.write(json.dumps(value, ensure_ascii=False) + '\n')
            f.flush()

    def send(self, value):
        self.process.stdin.write(json.dumps(value) + '\n')
        self.process.stdin.flush()

    def call(self, method, params):
        self.counter += 1
        rid = self.counter
        self.send({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params})
        for line in self.process.stdout:
            message = json.loads(line)
            if message.get('id') == rid and 'method' not in message:
                if 'error' in message:
                    raise RuntimeError(json.dumps(message['error'], ensure_ascii=False))
                return message.get('result', {})
            if message.get('method') == 'session/request_permission':
                outcome = {'outcome': 'cancelled'}
                if self.control_dir is None:
                    self.denied += 1
                    self.record({'type': 'permission_denied', 'request': message.get('params')})
                else:
                    request_id = uuid.uuid4().hex
                    self.record({'type': 'permission_request', 'requestId': request_id,
                                 'request': message.get('params')})
                    reply = self.control_dir / (request_id + '.json')
                    # TaskService owns the user wait and timeout. This bound is only
                    # a guard against an orphaned ACP connection.
                    deadline = time.monotonic() + 14400
                    while time.monotonic() < deadline and self.process.poll() is None:
                        if reply.exists():
                            try:
                                decision = json.loads(reply.read_text()).get('decision')
                            finally:
                                reply.unlink(missing_ok=True)
                            if decision == 'allow':
                                outcome = {'outcome': 'selected', 'optionId': 'allow-once'}
                            else:
                                outcome = {'outcome': 'selected', 'optionId': 'reject-once'}
                                self.denied += 1
                            break
                        time.sleep(0.1)
                    else:
                        self.denied += 1
                    self.record({'type': 'permission_resolved', 'requestId': request_id,
                                 'decision': 'allow' if outcome.get('optionId') == 'allow-once' else 'deny'})
                self.send({'jsonrpc': '2.0', 'id': message['id'], 'result': {'outcome': outcome}})
            elif 'id' in message and 'method' in message:
                self.send({'jsonrpc': '2.0', 'id': message['id'],
                           'error': {'code': -32601, 'message': 'Unsupported client method'}})
            else:
                self.record(message)
                update = message.get('params', {}).get('update', {})
                if update.get('sessionUpdate') == 'agent_message_chunk':
                    content = update.get('content', {})
                    if content.get('type') == 'text':
                        self.text.append(content['text'])
        raise RuntimeError('DSH disconnected before reply: ' + ''.join(self.errors)[-2000:])

    def finish(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.reader.join(timeout=2)


def save_receipt(path, report):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(report, ensure_ascii=False))
    temp.replace(path)


def run(binary, patch, state, cwd, prompt, resume, action, run_id):
    os.umask(0o077)
    state = Path(state)
    event_file = Path(os.environ['WORKBENCH_DSH_EVENT_FILE']) if os.environ.get('WORKBENCH_DSH_EVENT_FILE') else state / ('events-' + run_id + '.jsonl')
    client = Client([binary, '--profile', 'acp', '--patch', patch], event_file)
    sid = resume
    opened = False
    report = {'sessionId': sid, 'eventFile': str(event_file), 'resumed': bool(resume)}
    try:
        info = client.call('initialize', {'protocolVersion': 1, 'clientCapabilities': {},
                                         'clientInfo': {'name': 'agent-workbench', 'version': '1'}})
        caps = info.get('agentCapabilities', {}).get('sessionCapabilities', {})
        if not all(x in caps for x in ('resume', 'close', 'list')):
            raise RuntimeError('DSH lacks required persistent-session capabilities')
        if action == 'list':
            sessions = []
            cursor = None
            while True:
                page = client.call('session/list', {'cwd': cwd, **({'cursor': cursor} if cursor else {})})
                sessions.extend(page.get('sessions', []))
                cursor = page.get('nextCursor')
                if not cursor:
                    break
            report.update(sessions=sessions, success=True)
        else:
            params = {'cwd': cwd, 'mcpServers': []}
            if sid:
                client.call('session/resume', {**params, 'sessionId': sid})
            else:
                sid = client.call('session/new', params)['sessionId']
            opened = True
            report['sessionId'] = sid
            client.record({'type': 'session_opened', 'sessionId': sid, 'resumed': bool(resume)})
            # Save receipt before prompt, so an interrupted run can be recovered explicitly.
            receipt = state / ('run-' + run_id + '.json')
            save_receipt(receipt, report)
            result = client.call('session/prompt', {'sessionId': sid,
                                'prompt': [{'type': 'text', 'text': Path(prompt).read_text()}]})
            report.update(result)
            report['success'] = result.get('stopReason') == 'end_turn' and client.denied == 0
    except Exception as exc:
        report.update(success=False, error=str(exc))
    finally:
        if opened:
            try:
                client.call('session/close', {'sessionId': sid})
                report['sessionClosed'] = True
            except Exception as exc:
                report.update(success=False, closeError=str(exc))
        client.finish()
    report.update(text=''.join(client.text), permissionsDenied=client.denied,
                  processExited=client.process.poll() is not None)
    save_receipt(state / ('run-' + run_id + '.json'), report)
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report.get('success') else 1


if __name__ == '__main__':
    sys.exit(run(*sys.argv[1:]))
