import { LiveProfessorDashboard } from '@/components/professor/LiveProfessorDashboard';
export default async function Page({params}:{params:Promise<{sessionId:string}>}){return <LiveProfessorDashboard sessionId={(await params).sessionId}/>}
