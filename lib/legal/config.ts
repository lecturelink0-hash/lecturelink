export const TERMS_VERSION = '2026-08-13';
export const PRIVACY_VERSION = '2026-08-13';
export const REFUND_POLICY_VERSION = '2026-08-13';

export const SUPPORT_EMAIL = 'goodwood0202@gmail.com';

export function legalOperator() {
  return {
    businessName: process.env.LEGAL_BUSINESS_NAME?.trim() || 'LectureLink',
    representative: process.env.LEGAL_REPRESENTATIVE?.trim() || '운영자 정보 등록 전',
    address: process.env.LEGAL_BUSINESS_ADDRESS?.trim() || '사업장 정보 등록 전',
    registrationNumber: process.env.LEGAL_BUSINESS_REGISTRATION_NUMBER?.trim() || '등록 전',
    mailOrderNumber: process.env.LEGAL_MAIL_ORDER_NUMBER?.trim() || '유료 판매 개시 전',
    phone: process.env.LEGAL_SUPPORT_PHONE?.trim() || '이메일 문의',
    privacyOfficer: process.env.LEGAL_PRIVACY_OFFICER?.trim() || '개인정보 보호 담당자',
    supportEmail: process.env.LEGAL_SUPPORT_EMAIL?.trim() || SUPPORT_EMAIL,
  };
}

export function overseasRegions() {
  return {
    supabase: process.env.LEGAL_SUPABASE_REGION?.trim() || '운영 프로젝트가 설정된 국가',
    vercel: process.env.LEGAL_VERCEL_REGION?.trim() || '운영 배포가 처리되는 국가',
    google: process.env.LEGAL_GOOGLE_REGION?.trim() || '미국 등 Google이 서비스를 제공하는 국가',
    anthropic: process.env.LEGAL_ANTHROPIC_REGION?.trim() || '미국',
    voyage: process.env.LEGAL_VOYAGE_REGION?.trim() || '미국',
    upstash: process.env.LEGAL_UPSTASH_REGION?.trim() || '운영 큐가 설정된 국가',
    cpx: process.env.LEGAL_CPX_REGION?.trim() || 'CPX 서버가 배포된 국가',
  };
}
