export type LibrarySetStatus = 'inprogress' | 'done';

export function deriveLibrarySetStatus(total: number, attempted: number): LibrarySetStatus {
  return total > 0 && attempted >= total ? 'done' : 'inprogress';
}

export function findNextUnansweredQuestionId(
  questionIds: readonly string[],
  attemptedQuestionIds: readonly string[],
  lastAttemptedQuestionId?: string | null,
): string | null {
  if (questionIds.length === 0) return null;

  const attempted = new Set(attemptedQuestionIds);
  const lastIndex = lastAttemptedQuestionId
    ? questionIds.indexOf(lastAttemptedQuestionId)
    : -1;
  const ordered = lastIndex >= 0
    ? [...questionIds.slice(lastIndex + 1), ...questionIds.slice(0, lastIndex + 1)]
    : [...questionIds];

  return ordered.find((questionId) => !attempted.has(questionId)) ?? questionIds[0] ?? null;
}
