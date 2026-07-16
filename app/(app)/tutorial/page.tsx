'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Upload, BookOpen, FileCheck2, RotateCcw, GraduationCap } from 'lucide-react';

/** 학습 튜토리얼 — 서비스 사용법 안내(기획서: [학습 튜토리얼 페이지]). */
export default function TutorialPage() {
  return (
    <div className="ll-system-page max-w-3xl mx-auto">
      <PageHeader
        title="학습 튜토리얼"
        description="렉처링크로 어떻게 공부하는지 한눈에 안내해 드릴게요."
      />

      <div className="space-y-4">
        <Card icon={<Upload className="w-5 h-5" strokeWidth={1.9} />} title="1. 자료 업로드 → 문제 생성">
          <ul className="list-disc pl-5 space-y-1.5 text-sm text-sage-800 leading-relaxed">
            <li>강의자료(PDF·PPTX·DOCX·이미지)를 올리면 AI가 시험 범위에 맞는 문제집을 만들어요.</li>
            <li>자료를 올리면 <b>문제 세트 정보</b>(이름·단원·난이도·문항 유형)가 자동으로 제안되고, 원하는 대로 바꿀 수 있어요.</li>
            <li>자료 안에 X-ray·ECG 같은 <b>의료 이미지</b>가 있으면, 그 이미지를 보고 푸는 문항도 함께 생성돼요.</li>
          </ul>
        </Card>

        <Card icon={<GraduationCap className="w-5 h-5" strokeWidth={1.9} />} title="2. 문항 유형 3가지">
          <div className="space-y-3 text-sm text-sage-800 leading-relaxed">
            <p><b className="text-sage-700">지식형</b> — 개념·정의·기전을 확인하는 문항. 기본 개념부터 지엽적인 내용까지.</p>
            <p><b className="text-sage-700">임상형</b> — 실제 환자 증례(나이·증상·검사)를 제시하고 진단·처치·판단을 묻는 문항.</p>
            <p><b className="text-sage-700">이미지형</b> — 업로드한 자료의 의료 이미지를 직접 판독·해석해야 푸는 문항.</p>
          </div>
        </Card>

        <Card icon={<BookOpen className="w-5 h-5" strokeWidth={1.9} />} title="3. 국시 문제 풀이">
          <ul className="list-disc pl-5 space-y-1.5 text-sm text-sage-800 leading-relaxed">
            <li>과목 → 세부주제를 고르면 바로 문제를 풀 수 있어요.</li>
            <li>한 문제를 풀면 즉시 채점되고(정답 초록·오답 빨강) 해설이 표시돼요.</li>
            <li>세부주제를 다 풀면 전체 채점 후, 체크한 문제만 골라 <b>오답노트</b>에 담을 수 있어요.</li>
          </ul>
        </Card>

        <Card icon={<RotateCcw className="w-5 h-5" strokeWidth={1.9} />} title="4. 오답노트 · 반복 학습">
          <ul className="list-disc pl-5 space-y-1.5 text-sm text-sage-800 leading-relaxed">
            <li><b>요약 보기</b>/<b>전체 보기</b> 중 원하는 방식으로 오답을 복습해요.</li>
            <li>틀린 문제는 <b>다시 풀기</b>로 재도전하거나, <b>유사문제 생성</b>으로 비슷한 문제를 더 풀 수 있어요.</li>
          </ul>
        </Card>

        <Card icon={<FileCheck2 className="w-5 h-5" strokeWidth={1.9} />} title="5. 모의고사(CBT)">
          <ul className="list-disc pl-5 space-y-1.5 text-sm text-sage-800 leading-relaxed">
            <li>과목을 골라 실제 국시 CBT와 유사한 환경에서 모의고사를 볼 수 있어요.</li>
            <li>표시(체크)·메모·계산기 등 CBT 도구를 그대로 사용해요. (국가고시 대비 이상 요금제)</li>
          </ul>
        </Card>
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/notes"><Button variant="accent" size="lg">지금 자료 올리고 시작하기</Button></Link>
        <Link href="/exam"><Button variant="secondary" size="lg">국시 문제 풀어보기</Button></Link>
      </div>
    </div>
  );
}
