import {useEffect,useState} from 'react';
export type {TaskNotice} from '../shared/task-notices';
import type {TaskNotice} from '../shared/task-notices';
const key='workbench.task-notices.v1';
export function useTaskNotices(){
 const [notices,setNotices]=useState<TaskNotice[]>([]);
 useEffect(()=>{
  let alive=true;
  const refresh=async()=>{const r=await (window as any).wb.invoke('notices.list');if(alive&&r.ok)setNotices(r.data);};
  const off=(window as any).wb.onEvent((e:any)=>{if(['result','error','permission_request'].includes(e.type))void refresh();});
  void (async()=>{
   let old=[];try{old=JSON.parse(localStorage.getItem(key)||'[]');}catch{}
   const r=await (window as any).wb.invoke('notices.import',{notices:old});
   if(r.ok){localStorage.removeItem(key);if(alive)setNotices(r.data);}
   await refresh();
  })();
  return()=>{alive=false;off();};
 },[]);
 return {notices,ack:(taskId:string)=>{void (window as any).wb.invoke('notices.ack',{taskId}).then((r:any)=>{if(r.ok)setNotices(r.data);});}};
}
