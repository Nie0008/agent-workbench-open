export interface TaskNotice { id: string; taskId: string; label: string; time: string }

export function noticeLabel(e: {type:string;payload?:any}) {
  if(e.type==='result')return e.payload?.isError?'执行出错':e.payload?.numTurns===0&&!e.payload?.text?null:'本轮完成 · 待验收';
  if(e.type==='permission_request')return '等你授权';
  if(e.type==='error')return '执行出错';
  return null;
}
