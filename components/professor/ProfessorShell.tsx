'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, LogOut, Menu, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createBrowserClient } from '@/lib/db/browser';
import './professor.css';

const NAV = [
  { href: '/professor', label: '대시보드' },
  { href: '/professor/courses', label: '내 강의실' },
  { href: '/professor/formative', label: '형성평가' },
  { href: '/professor/materials', label: '강의자료' },
  { href: '/professor/bridge', label: '선수지식' },
  { href: '/professor/quality', label: '품질 검사' },
] as const;

export function ProfessorShell({children,displayName,schoolName}:{children:React.ReactNode;displayName:string;schoolName:string|null}){
 const pathname=usePathname();const [open,setOpen]=useState(false);const [accountOpen,setAccountOpen]=useState(false);const accountRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{setOpen(false);setAccountOpen(false)},[pathname]);
 useEffect(()=>{if(!accountOpen)return;const close=(event:MouseEvent)=>{if(accountRef.current&&!accountRef.current.contains(event.target as Node))setAccountOpen(false)};document.addEventListener('mousedown',close);return()=>document.removeEventListener('mousedown',close)},[accountOpen]);
 async function logout(){await createBrowserClient().auth.signOut();window.location.href='/login'}
 const active=(href:string)=>pathname===href||(href!=='/professor'&&pathname.startsWith(`${href}/`));
 const logo=<Link href="/professor" className="professor-top-logo">{/* eslint-disable-next-line @next/next/no-img-element */}<img src="/lecturelink-mark.png" alt=""/><b>Lecturelink</b><small>FACULTY</small></Link>;
 return <div className="professor-app"><header className="professor-topbar"><div className="professor-topbar-inner">{logo}<nav className="professor-topnav" aria-label="교수 메뉴">{NAV.map(item=><Link className={active(item.href)?'is-active':''} href={item.href} key={item.href}>{item.label}</Link>)}</nav><div className="professor-top-account" ref={accountRef}><button type="button" onClick={()=>setAccountOpen(value=>!value)} aria-expanded={accountOpen} aria-haspopup="menu"><span>{displayName.charAt(0)}</span><span><b>{displayName}</b><small>{schoolName??'교수 계정'}</small></span><ChevronDown size={15}/></button>{accountOpen&&<div className="professor-account-menu" role="menu"><div><b>{displayName}</b><small>{schoolName??'LectureLink 교수'}</small></div><button type="button" onClick={logout} role="menuitem"><LogOut size={16}/>로그아웃</button></div>}</div><button className="professor-menu-trigger" type="button" onClick={()=>setOpen(true)} aria-label="메뉴 열기"><Menu size={21}/></button></div></header>{open&&<><button className="professor-menu-backdrop" type="button" onClick={()=>setOpen(false)} aria-label="메뉴 닫기"/><aside className="professor-mobile-menu"><div>{logo}<button type="button" onClick={()=>setOpen(false)} aria-label="메뉴 닫기"><X size={20}/></button></div><nav>{NAV.map(item=><Link className={active(item.href)?'is-active':''} href={item.href} key={item.href}>{item.label}</Link>)}</nav><div className="professor-mobile-account"><span>{displayName.charAt(0)}</span><div><b>{displayName}</b><small>{schoolName??'교수 계정'}</small></div><button type="button" onClick={logout}><LogOut size={16}/>로그아웃</button></div></aside></>}<main className="professor-content">{children}</main></div>
}
