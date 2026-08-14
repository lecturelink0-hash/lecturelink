/**
 * 학습 설정(학기·수강 과목) 공유 상수.
 *
 * 수강 과목은 users 테이블에 컬럼이 없어 브라우저 localStorage 에 기억한다 —
 * 프로필의 학습 설정 카드가 저장하고, 추천 풀이(practice)가 읽어
 * (학교, 학년, 학기, 연도, 과목) 조합으로 코호트를 찾는다.
 */

export const STUDY_SUBJECT_STORAGE_KEY = 'll:study-subject';

export function defaultSemester(): 'spring' | 'fall' {
  return new Date().getMonth() + 1 >= 7 ? 'fall' : 'spring';
}
