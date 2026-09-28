import importlib.util,json,sqlite3,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('entry',Path(__file__).parents[1]/'grok-glm.py');entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)
class BindingTests(unittest.TestCase):
 def test_no_secret_on_disk_and_no_silent_provider_change(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);db=root/'providers.db'
   c=sqlite3.connect(db);c.execute('create table providers(id text,app_type text,settings_config text)')
   env={'ANTHROPIC_MODEL':entry.MODEL,'ANTHROPIC_BASE_URL':'https://open.bigmodel.cn/api/anthropic','ANTHROPIC_AUTH_TOKEN':'fixture-secret'}
   c.execute('insert into providers values(?,?,?)',('a','claude',json.dumps({'env':env})));c.commit()
   home,child,_=entry.prepare(root,db,root/'state')
   self.assertEqual(child['WORKBENCH_GLM_KEY'],'fixture-secret')
   for p in home.iterdir():self.assertNotIn('fixture-secret',p.read_text())
   c.execute('insert into providers values(?,?,?)',('b','claude',json.dumps({'env':env})));c.commit()
   with self.assertRaises(ValueError):entry.provider(db)
   with self.assertRaises(ValueError):entry.prepare(root,db,root/'state','b')
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
