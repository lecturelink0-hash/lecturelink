export const TERMS_VERSION = '2026-08-13';
export const PRIVACY_VERSION = '2026-08-13';
export const REFUND_POLICY_VERSION = '2026-08-13';

export const SUPPORT_EMAIL = 'lecturelink0@gmail.com';

export function legalOperator() {
  return {
    businessName: process.env.LEGAL_BUSINESS_NAME?.trim() || 'LectureLink',
    representative: process.env.LEGAL_REPRESENTATIVE?.trim() || '장유림',
    address: process.env.LEGAL_BUSINESS_ADDRESS?.trim() || '대구 남구 명덕로 104 동산관 1층 151호 공유오피스',
    registrationNumber: process.env.LEGAL_BUSINESS_REGISTRATION_NUMBER?.trim() || '등록 전',
    mailOrderNumber: process.env.LEGAL_MAIL_ORDER_NUMBER?.trim() || '유료 판매 개시 전',
    phone: process.env.LEGAL_SUPPORT_PHONE?.trim() || '010-5035-5681',
    privacyOfficer: process.env.LEGAL_PRIVACY_OFFICER?.trim() || '장유림',
    supportEmail: process.env.LEGAL_SUPPORT_EMAIL?.trim() || SUPPORT_EMAIL,
  };
}

export function overseasRegions() {
  return {
    supabase: process.env.LEGAL_SUPABASE_REGION?.trim() || '대한민국',
    vercel: process.env.LEGAL_VERCEL_REGION?.trim() || '대한민국',
    google: process.env.LEGAL_GOOGLE_REGION?.trim() || '미국',
    anthropic: process.env.LEGAL_ANTHROPIC_REGION?.trim() || '미국',
    voyage: process.env.LEGAL_VOYAGE_REGION?.trim() || '미국',
    upstash: process.env.LEGAL_UPSTASH_REGION?.trim() || '미국',
    cpx: process.env.LEGAL_CPX_REGION?.trim() || '대한민국',
  };
}
