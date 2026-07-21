import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { getAnthropic, MODELS, createMessage, withRetry } from '@/lib/ai/client';
import { requireDailyCostCap } from '@/lib/ai/cost-cap';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';

const requestSchema = z.object({
  questions: z.string().trim().min(20).max(60_000),
  objectives: z.string().trim().max(5_000).default(''),
  taughtScope: z.string().trim().max(8_000).default(''),
});

const resultSchema = z.object({
  overallVerdict: z.enum(['양호', '수정 권장', '검토 필요']),
  summary: z.string().min(1),
  distribution: z.object({ recall: z.number().int().min(0), understanding: z.number().int().min(0), application: z.number().int().min(0) }),
  coverageNotes: z.array(z.string()).max(6),
  items: z.array(z.object({
    number: z.number().int().min(1),
    verdict: z.enum(['통과', '수정 권장', '검토 필요']),
    testedObjective: z.string().min(1),
    flags: z.array(z.object({ category: z.enum(['복수정답', '모호성', '정답 단서', '범위 밖', '목표 불일치', '내용 정확성', '기타']), severity: z.enum(['낮음', '중간', '높음']), message: z.string().min(1), suggestion: z.string().min(1) })).max(6),
  })).min(1).max(60),
});

const outputTool = { name: 'review_formative_quality', description: 'Audit formative assessment quality.', input_schema: { type: 'object', required: ['overallVerdict','summary','distribution','coverageNotes','items'], properties: { overallVerdict: { type:'string', enum:['양호','수정 권장','검토 필요'] }, summary:{type:'string'}, distribution:{type:'object',required:['recall','understanding','application'],properties:{recall:{type:'integer'},understanding:{type:'integer'},application:{type:'integer'}}}, coverageNotes:{type:'array',items:{type:'string'},maxItems:6}, items:{type:'array',minItems:1,maxItems:60,items:{type:'object',required:['number','verdict','testedObjective','flags'],properties:{number:{type:'integer',minimum:1},verdict:{type:'string',enum:['통과','수정 권장','검토 필요']},testedObjective:{type:'string'},flags:{type:'array',maxItems:6,items:{type:'object',required:['category','severity','message','suggestion'],properties:{category:{type:'string',enum:['복수정답','모호성','정답 단서','범위 밖','목표 불일치','내용 정확성','기타']},severity:{type:'string',enum:['낮음','중간','높음']},message:{type:'string'},suggestion:{type:'string'}}}}}}} } } } as const;

export const maxDuration = 120;
export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  if (session.profile.accountType !== 'professor' && session.role !== 'admin') throw new ApiException('professor_only','교수 계정에서만 사용할 수 있습니다.',403);
  await requireDailyCostCap();
  const input = requestSchema.parse(await request.json());
  const response = await withRetry(() => createMessage(getAnthropic(), { model: MODELS.generation(), max_tokens: 7000, system: `당신은 의학교육 형성평가 문항의 품질을 검토하는 교수지원 조교다. 고부담 시험의 합격/불합격 판정이 아니라 학생 학습을 돕는 형성평가 개선이 목적이다. 복수정답 가능성, 모호한 표현, 문법적 정답 단서, 수업 범위 밖 내용, 학습목표 불일치, 인지수준 편중을 보수적으로 점검한다. 제공되지 않은 수업 범위나 목표는 추정했다고 명시하며 단정하지 않는다. 모든 지적에는 실행 가능한 수정 제안을 붙인다.`, tools:[outputTool], tool_choice:{type:'tool',name:'review_formative_quality'}, messages:[{role:'user',content:`학습목표:\n${input.objectives||'미제공'}\n\n수업에서 다룬 범위:\n${input.taughtScope||'미제공'}\n\n검토할 형성평가:\n${input.questions}`}] }), {maxAttempts:3});
  const block=response.content.find((item):item is Anthropic.ToolUseBlock=>item.type==='tool_use');
  if(!block) throw new ApiException('analysis_failed','문항 품질 분석 결과를 만들지 못했습니다.',502);
  return ok(resultSchema.parse(block.input));
});
