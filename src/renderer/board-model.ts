export function taskLane(t: {status:string}) {
  if(t.status==='running')return 'running';
  if(t.status==='waiting_permission')return 'permission';
  if(['resuming','interrupted'].includes(t.status))return 'paused';
  return 'ended';
}
export function taskLabel(t:{status:string;summary?:string|null}) {
  return ({running:'执行中',waiting_permission:'等你授权',resuming:'待继续',interrupted:'已中断 · 待继续',completed:'执行完成 · 待验收',failed:'执行失败',timeout:'执行超时',stopped:'已停止',canceled:'已取消'} as Record<string,string>)[t.status] ?? (t.status==='idle'?(t.summary?'本轮已结束':'等待指令'):'状态未知');
}
export {noticeLabel} from '../shared/task-notices';
export const agentName=(id:string)=>({'claude-code':'Claude Code',grok:'Grok Build',dsh:'DSH',zcode:'ZCode'} as Record<string,string>)[id]??id;
