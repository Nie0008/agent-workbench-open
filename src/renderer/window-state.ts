import {useLayoutEffect,useState,type Dispatch,type SetStateAction} from 'react';
import {projectWindowDraft,projectWindowDrafts} from './window-drafts';

let restored: Record<string,unknown> = {};
const values = new Map<string,unknown>();
let ready = false;
export function initializeWindowState(value: unknown) {
  restored=projectWindowDrafts(value);
  ready=true;
}
export function hasRestoredState(key: string) { return Object.hasOwn(restored,key); }
export function useWindowState<T>(key: string, fallback: T, valid?: (value: unknown)=>boolean, keepOnUnmount=false): [T,Dispatch<SetStateAction<T>>] {
  const [value,setValue]=useState<T>(()=>{
    const saved=projectWindowDraft(key,keepOnUnmount && values.has(key) ? values.get(key) : restored[key]);
    delete restored[key];
    const allowed=valid ? valid(saved) : saved===null ? fallback===null
      : typeof saved===typeof fallback && !Array.isArray(saved) && (typeof saved!=='number' || Number.isFinite(saved));
    return allowed ? saved as T : fallback;
  });
  useLayoutEffect(()=>{
    values.set(key,projectWindowDraft(key,value));
    return ()=>{if(!keepOnUnmount)values.delete(key);};
  },[key,value,keepOnUnmount]);
  return [value,setValue];
}
(window as any).__workbenchWindowSnapshot=async()=>{
  if(!ready)throw new Error('窗口正在读取，请稍后收起');
  await (window as any).wb.waitForRequests();
  // Let the resolved send/save handler clear its draft and React commit before checkpointing.
  await new Promise(resolve=>setTimeout(resolve,0));
  return projectWindowDrafts(Object.fromEntries([...Object.entries(restored),...values]));
};
