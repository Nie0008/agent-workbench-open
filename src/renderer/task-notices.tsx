import {useEffect,useState} from 'react';
import {noticeLabel} from './board-model';
export interface TaskNotice {id:string;taskId:string;label:string;time:string}
const key='workbench.task-notices.v1';
export function useTaskNotices(){
 const [notices,setNotices]=useState<TaskNotice[]>(()=>{try{const v=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(v)?v.filter(x=>typeof x?.id==='string'&&typeof x?.taskId==='string'&&typeof x?.label==='string').slice(0,50):[];}catch{return [];}});
 useEffect(()=>{try{localStorage.setItem(key,JSON.stringify(notices));}catch{}},[notices]);
 useEffect(()=> (window as any).wb.onEvent((e:any)=>{const label=noticeLabel(e);if(!label)return;const id=`${e.sessionId}:${e.seq}`;setNotices(prev=>prev.some(n=>n.id===id)?prev:[{id,taskId:e.sessionId,label,time:e.createdAt},...prev].slice(0,50));}),[]);
 return {notices,ack:(taskId:string)=>setNotices(ns=>ns.filter(n=>n.taskId!==taskId))};
}
