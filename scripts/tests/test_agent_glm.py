import contextlib,importlib.util,io,json,tempfile,unittest,urllib.request,urllib.error
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('agents',Path(__file__).parents[1]/'agent-glm.py');entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)
class RelayTests(unittest.TestCase):
 def test_wrong_model_and_missing_local_auth_never_forward(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);binary=root/'dsh';binary.touch();captured=[]
   class Process:
    returncode=0;pid=1
    def __init__(self,cmd,**kw):
     self.env=kw['env'];self.config=Path(cmd[3]);captured.append(kw)
     assert 'provider-secret' not in str(kw)
     assert 'provider-secret' not in self.config.read_text()
    def poll(self):return 0
    def communicate(self,**kw):
     cfg=json.loads(self.config.read_text())[-1]['config']['providers']['cc-workbench'];url=cfg['baseURL']+'/v1/messages'
     assert cfg['models'][0]['id']=='second-model'
     for auth,status in [(False,401),(True,400)]:
      headers={'Content-Type':'application/json'}
      if auth:headers['x-api-key']=self.env['WORKBENCH_GLM_LOCAL_TOKEN']
      req=urllib.request.Request(url,data=b'{"model":"wrong-model"}',headers=headers)
      try:urllib.request.urlopen(req);raise AssertionError('must reject')
      except urllib.error.HTTPError as e:assert e.code==status
     return 'DSH_GLM_OK',''
   output=io.StringIO()
   with patch.object(entry.Path,'home',return_value=root),patch.object(entry,'DSH',binary),patch.object(entry.shared,'anthropic_provider',return_value=('p','provider-secret','https://example.invalid/api/anthropic')),patch.object(entry.subprocess,'Popen',Process),patch.object(entry.sys,'argv',['entry','dsh','smoke','--cwd',str(root),'--model','second-model']),contextlib.redirect_stdout(output):
    self.assertEqual(entry.main(),1)
   result=json.loads(output.getvalue());self.assertFalse(result['inferenceVerified']);self.assertTrue(result['requests'][0]['blocked'])
   self.assertFalse(list(root.rglob('run-*')))
if __name__=='__main__':unittest.main()
