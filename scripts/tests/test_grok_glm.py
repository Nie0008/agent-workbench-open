import importlib.util,json,sqlite3,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('entry',Path(__file__).parents[1]/'grok-glm.py');entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)
class BindingTests(unittest.TestCase):
 def test_explicit_model_is_required_before_reading_credentials(self):
  with patch.object(entry,'provider') as provider:
   with self.assertRaisesRegex(ValueError,'Explicit model'):entry.prepare(Path('/fixture'),Path('/missing'),Path('/unused'))
   provider.assert_not_called()
 def test_acp_passes_max_to_the_grok_cli_before_stdio(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);binary=root/'grok';binary.touch()
   with patch.object(entry,'runtime_executable',return_value=binary),patch.object(entry,'prepare',return_value=(root,{},{})),patch.object(entry.subprocess,'run',return_value=type('Checked',(),{'returncode':0,'stdout':'second-model'})()),patch.object(entry.os,'execve',side_effect=RuntimeError('captured exec')) as execute,patch.object(entry.sys,'argv',['entry','acp','--cwd',d,'--provider-id','fixture','--model','second-model','--reasoning-effort','max']):
    with self.assertRaisesRegex(RuntimeError,'captured exec'):entry.main()
   self.assertEqual(execute.call_args.args[1],[str(binary),'agent','--no-leader','--model','second-model','--reasoning-effort','max','stdio'])
 def test_no_secret_on_disk_and_no_silent_provider_change(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);db=root/'providers.db'
   c=sqlite3.connect(db);c.execute('create table providers(id text,app_type text,settings_config text)')
   env={'ANTHROPIC_MODEL':'fixture-model','ANTHROPIC_BASE_URL':'https://open.bigmodel.cn/api/anthropic','ANTHROPIC_AUTH_TOKEN':'fixture-secret'}
   c.execute('insert into providers values(?,?,?)',('a','claude',json.dumps({'env':env})));c.commit()
   home,child,_=entry.prepare(root,db,root/'state',model='fixture-model')
   self.assertEqual(child['WORKBENCH_GLM_KEY'],'fixture-secret')
   for p in home.iterdir():self.assertNotIn('fixture-secret',p.read_text())
   c.execute('insert into providers values(?,?,?)',('b','claude',json.dumps({'env':env})));c.commit()
   with self.assertRaises(ValueError):entry.provider(db)
   with self.assertRaises(ValueError):entry.prepare(root,db,root/'state','b',model='fixture-model')
   self.assertEqual(entry.provider(db,'a')[0],'a');c.close()
 def test_wrong_model_or_endpoint_is_not_reused(self):
  with tempfile.TemporaryDirectory() as d:
   db=Path(d)/'db';c=sqlite3.connect(db);c.execute('create table providers(id text,app_type text,settings_config text)')
   c.execute('insert into providers values(?,?,?)',('a','claude',json.dumps({'env':{'ANTHROPIC_MODEL':'another','ANTHROPIC_AUTH_TOKEN':'fixture'}})));c.commit();c.close()
   with self.assertRaises(ValueError):entry.provider(db)
 def test_local_workbench_source_uses_inherited_key_without_cc_switch(self):
  with patch.dict(entry.os.environ,{'ANTHROPIC_AUTH_TOKEN':'local-fixture','ANTHROPIC_BASE_URL':'https://open.bigmodel.cn/api/anthropic'}):
   self.assertEqual(entry.provider(Path('/missing/cc.db'),'workbench-local:test'),('workbench-local:test','local-fixture'))
  with patch.dict(entry.os.environ,{'ANTHROPIC_AUTH_TOKEN':'','ANTHROPIC_API_KEY':'','ANTHROPIC_BASE_URL':'https://open.bigmodel.cn/api/anthropic'}):
   with self.assertRaises(ValueError):entry.provider(Path('/missing/cc.db'),'workbench-local:test')
if __name__=='__main__':unittest.main()
