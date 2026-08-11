import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(
    {
      commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? 'local',
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? process.env.GIT_BRANCH ?? 'local',
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
