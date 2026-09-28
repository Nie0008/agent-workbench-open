import {projectName} from './project-name';
import React,{useEffect,useState} from 'react';
import {taskLane,taskLabel,agentName} from './board-model';
import type {TaskNotice} from './task-notices';
const wb=(window as any).wb;
const layoutKey='workbench.project-layout.v1';
const lanes=[{id:'running',label:'执行中'},{id:'permission',label:'等你授权'},{id:'paused',label:'待继续'},{id:'ended',label:'已结束 / 等待指令'}];
export function ProgressPanel({onClose,onOpen,notices,ack}:{onClose:()=>void;onOpen:(task:any)=>void;notices:TaskNotice[];ack:(id:string)=>void}){
 const [data,setData]=useState<any>(null),[projects,setProjects]=useState<any[]>([]),[error,setError]=useState(''),[query,setQuery]=useState(''),[expanded,setExpanded]=useState<Record<string,boolean>>({}),[showNotices,setShowNotices]=useState(false);
 useEffect(()=>{
  let alive=true,busy=false,windowVisible=true,visibilityEvents=0;
  const refresh=async()=>{
   if(!alive||busy||!windowVisible||document.hidden)return;
   busy=true;
   try{
    const [r,p]=await Promise.all([wb.invoke('tasks.progress',{}),wb.invoke('projects.list')]);
    if(alive){if(r.ok){setData(r.data);setError('');}else setError(r.error);if(p.ok)setProjects(p.data);}
   }catch{if(alive)setError('连接中断，以下保留的是上次状态');}
   finally{busy=false;}
  };
  const visible=()=>{if(!document.hidden)void refresh();};
  const offVisibility=wb.onWindowVisibility((value:boolean)=>{
   visibilityEvents++;windowVisible=value;if(value)void refresh();
  });
  void wb.invoke('app.windowState').then((r:any)=>{
   if(alive&&visibilityEvents===0&&r.ok){windowVisible=r.data.visible;if(windowVisible)void refresh();}
  });
  void refresh();
  const timer=setInterval(refresh,5000);
  document.addEventListener('visibilitychange',visible);
  const off=wb.onEvent((e:any)=>{if(['session','result','error','permission_request','permission_resolved'].includes(e.type))void refresh();});
  return()=>{alive=false;clearInterval(timer);document.removeEventListener('visibilitychange',visible);offVisibility();off();};
 },[]);
 const [layout,setLayout]=useState<{order:string[];closed:Record<string,boolean>;heights:Record<string,number>}>(()=>{try{const x=JSON.parse(localStorage.getItem(layoutKey)||'null');return {order:Array.isArray(x?.order)?x.order.filter((v:any)=>typeof v==='string'):[],closed:x?.closed||{},heights:x?.heights||{}};}catch{return {order:[],closed:{},heights:{}};}});
 const [drag,setDrag]=useState<string|null>(null);
 useEffect(()=>{try{localStorage.setItem(layoutKey,JSON.stringify(layout));}catch{}},[layout]);
 const reorder=(source:string,target:string)=>{if(source===target)return;setLayout(v=>{const order=[...new Set([...v.order,...ids])].filter(id=>id!==source);order.splice(order.indexOf(target),0,source);return {...v,order};});setDrag(null);};
 const resize=(id:string,e:React.PointerEvent<HTMLDivElement>)=>{e.currentTarget.setPointerCapture(e.pointerId);e.currentTarget.dataset.startY=String(e.clientY);e.currentTarget.dataset.startHeight=String(e.currentTarget.parentElement?.querySelector('.project-lanes')?.getBoundingClientRect().height||280);};
 const all:any[]=data?.tasks??[];
 const pname=(id:string)=>projectName(projects.find(p=>p.id===id));
 const tasks=all.filter(t=>`${pname(t.projectId)} ${t.title} ${t.agentId} ${t.model}`.toLowerCase().includes(query.toLowerCase()));
 const ids=[...new Set(tasks.map(t=>t.projectId))].sort((a,b)=>{
  const rank=(id:string)=>tasks.some(t=>t.projectId===id&&['running','waiting_permission'].includes(t.status))?1:0;
  const last=(id:string)=>Math.max(...tasks.filter(t=>t.projectId===id).map(t=>Date.parse(t.lastActivityAt)||0));
  const ai=layout.order.indexOf(a),bi=layout.order.indexOf(b);if(ai>=0||bi>=0)return (ai<0?1e9:ai)-(bi<0?1e9:bi);return rank(b)-rank(a)||last(b)-last(a);
 });
 const children=(id:string)=>all.filter(t=>t.parentTaskId===id);
 const childTree=(parent:string,path:string[]=[]):React.ReactNode=>path.includes(parent)?null:children(parent).map(t=><div className="subagent-node" key={t.taskId}><button className="task-open" onClick={()=>open(t)}>↳ {agentName(t.agentId)} · {t.title}</button><div className="task-state">{taskLabel(t)} · {t.model||'模型未记录'}</div>{childTree(t.taskId,[...path,parent])}</div>);
 const open=(t:any)=>{ack(t.taskId);onOpen(t);};
 return <div className="modal-mask board-mask"><section className="task-board project-board" aria-label="任务看板">
  <header className="project-board-header"><h1>项目任务</h1><input aria-label="搜索项目或任务" placeholder="搜索项目、任务、Agent" value={query} onChange={e=>setQuery(e.target.value)}/><span className="board-refresh">{data?`${new Date(data.serverTime).toLocaleTimeString()} 更新`:'连接中…'}</span><button className="btn" onClick={()=>setShowNotices(!showNotices)}>新动态 {notices.length||''}</button><button className="btn" onClick={onClose}>进入工作区</button></header>
  {error&&<p role="alert" className="board-error">{error}</p>}
  {showNotices&&<aside className="board-inbox"><h2>新动态</h2>{!notices.length&&<p>暂无未读动态。工作台运行时，会接收新的完成、出错和授权提醒。</p>}{notices.map(n=>{const t=all.find(t=>t.taskId===n.taskId);return <div key={n.id}><span>{t?`${pname(t.projectId)} · ${t.title}`:'历史任务'} — {n.label}</span>{t&&<button className="btn" onClick={()=>open(t)}>查看任务</button>}<button className="btn" onClick={()=>ack(n.taskId)}>标为已读</button></div>;})}</aside>}
  <details className="board-scope"><summary>自动刷新 · 仅显示已接入任务 · 通知说明</summary><p>显示时每 5 秒刷新已登记的最近 200 个任务，收起后暂停刷新，再打开立即更新，不调用模型。直接启动的外部 CLI 暂不包含。收起到菜单栏后仍保留未读动态；退出应用期间不补发提醒，不是系统推送。Codex 在等待任务事件时能接收结果，已结束的 Codex 对话不会自动被唤醒。执行完成仍需验收。</p></details>
  {!tasks.length&&<p className="board-empty">{data?'暂无匹配任务':'正在读取任务…'}</p>}
  {ids.map(id=>{const items=tasks.filter(t=>t.projectId===id).sort((a,b)=>Date.parse(b.lastActivityAt)-Date.parse(a.lastActivityAt));const live=items.filter(t=>['running','waiting_permission'].includes(t.status));return <section className="project-task-row" data-project-id={id} key={id} aria-label={`${pname(id)} 项目任务`} onDragOver={e=>{if(drag)e.preventDefault();}} onDrop={e=>{e.preventDefault();if(drag)reorder(drag,id);}}>
   <header className="project-row-title"><button className="project-grip" onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);setDrag(id);}} onPointerUp={e=>{const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-project-id]')?.getAttribute('data-project-id');if(target)reorder(id,target);setDrag(null);e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>setDrag(null)} onDragStart={e=>{setDrag(id);e.dataTransfer.setData("text/plain",id);e.dataTransfer.effectAllowed="move";}} onDragEnd={()=>setDrag(null)} aria-label={`拖动排序 ${pname(id)}`} title="拖动调整项目顺序">⠿</button><button className="project-toggle" title={projects.find(p=>p.id===id)?.rootPath} aria-expanded={!layout.closed[id]} onClick={()=>setLayout(v=>({...v,closed:{...v.closed,[id]:!v.closed[id]}}))}>{layout.closed[id]?"▸":"▾"} {pname(id)}</button><button className="project-move" aria-label={`上移 ${pname(id)}`} disabled={ids.indexOf(id)===0} onClick={()=>reorder(id,ids[ids.indexOf(id)-1])}>↑</button><span>{items.length} 个任务</span><div className="project-live">{live.length?[...new Set(live.map(t=>`${agentName(t.agentId)} · ${t.model||'模型未记录'}${t.status==='waiting_permission'?'（等授权）':''}`))].map(a=><span key={a}>● {a}</span>):<span className="no-active">当前没有执行中的 Agent</span>}</div></header>
   <div className="project-lanes" hidden={!!layout.closed[id]} style={layout.heights[id]?{height:Math.max(180,Math.min(900,layout.heights[id])),overflowY:"auto"}:undefined}>{lanes.map(l=>{const list=items.filter(t=>taskLane(t)===l.id&&(!t.parentTaskId||!items.some(p=>p.taskId===t.parentTaskId))),key=`${id}:${l.id}`,limit=expanded[key]?list.length:2;return <section className={`project-lane lane-${l.id}`} key={l.id}><h3>{l.label}<span>{list.length}</span></h3>{!list.length&&<p className="lane-empty">暂无</p>}{list.slice(0,limit).map(t=><article className="project-task" key={t.taskId}>
    <button className="task-open" onClick={()=>open(t)}>{notices.some(n=>n.taskId===t.taskId)&&<span className="unread-dot" title="有新动态">● </span>}{t.title}</button><div className="task-state">{taskLabel(t)}{t.parentTaskId?` · 主任务：${all.find(p=>p.taskId===t.parentTaskId)?.title||'不在最近记录内'}`:''}</div><p className="board-agent">{agentName(t.agentId)} · {t.model||'模型未记录'}</p><p className="task-preview">{t.waitReason||t.summary||'暂无进度说明'}</p>{t.suspectedStall&&<p className="board-warning">一段时间没有新输出，可查看执行记录</p>}<time>{new Date(t.lastActivityAt).toLocaleString()}</time><button className="task-detail" onClick={()=>open(t)}>{t.status==='waiting_permission'?'查看并决定是否授权':'查看详情 →'}</button>
   <details className="subagent-tree"><summary>子 Agent / 子任务 · {children(t.taskId).length}</summary>{children(t.taskId).length?childTree(t.taskId):<p>尚无已上报的子任务。工具内部创建的 Agent 需接入上报后才能显示。</p>}</details></article>)}{list.length>2&&<button className="lane-more" onClick={()=>setExpanded(s=>({...s,[key]:!s[key]}))}>{expanded[key]?'收起':`再看 ${list.length-2} 个任务`}</button>}</section>;})}</div>
  <div className="project-resize" hidden={!!layout.closed[id]} role="separator" aria-label={`调整 ${pname(id)} 行高`} aria-orientation="horizontal" tabIndex={0} onDoubleClick={()=>setLayout(v=>({...v,heights:{...v.heights,[id]:0}}))} onPointerDown={e=>resize(id,e)} onPointerMove={e=>{if(!e.currentTarget.hasPointerCapture(e.pointerId))return;const height=Math.max(180,Math.min(900,Number(e.currentTarget.dataset.startHeight)+e.clientY-Number(e.currentTarget.dataset.startY)));setLayout(v=>({...v,heights:{...v.heights,[id]:height}}));}} onPointerUp={e=>e.currentTarget.releasePointerCapture(e.pointerId)} onKeyDown={e=>{if(e.key!=="ArrowDown"&&e.key!=="ArrowUp")return;e.preventDefault();setLayout(v=>({...v,heights:{...v.heights,[id]:Math.max(180,Math.min(900,(v.heights[id]||280)+(e.key==="ArrowDown"?24:-24)))}}));}} title="拖动调整行高；双击恢复自动高度">⋯</div></section>;})}
 </section></div>;
}
