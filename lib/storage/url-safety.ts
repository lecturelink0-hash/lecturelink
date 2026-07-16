/**
 * 이미지 URL SSRF 방어
 *
 * /api/questions/generate 등에서 사용자 입력 image_url 을 Claude Vision 에 그대로
 * 넘기면 내부망 포트 스캔·메타데이터 서비스 노출 등 SSRF 가 가능하다.
 *
 * 허용 호스트:
 *   1. Supabase Storage public/signed URL  (NEXT_PUBLIC_SUPABASE_URL 도메인)
 *   2. open_images 인제스트로 들어온 신뢰 도메인 (open-image-domains.json)
 *
 * 거부 대상:
 *   - 비-HTTPS
 *   - 사설망 (RFC1918, link-local, loopback, IPv4-mapped IPv6)
 *   - 사용자 정의 포트
 *   - localhost / *.internal / metadata.google.internal 등
 */

import { ApiException } from '@/lib/utils/api';

const OPEN_IMAGE_TRUSTED_HOSTS = [
  // PubMed Central Open Access
  'www.ncbi.nlm.nih.gov',
  'pmc.ncbi.nlm.nih.gov',
  // NIH Open-i
  'openi.nlm.nih.gov',
  // Wikipedia Commons
  'upload.wikimedia.org',
];

function getSupabaseHost(): string | null {
  try {
    const u = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!u) return null;
    return new URL(u).host;
  } catch {
    return null;
  }
}

function isPrivateIpv4(host: string): boolean {
  // 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 0.0.0.0/8
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique local
  if (h.startsWith('fe80:')) return true; // link local
  if (h.startsWith('::ffff:')) {
    // IPv4-mapped
    const v4 = h.slice('::ffff:'.length);
    return isPrivateIpv4(v4);
  }
  return false;
}

function isSuspiciousHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost') return true;
  if (h.endsWith('.localhost')) return true;
  if (h.endsWith('.internal')) return true;
  if (h.endsWith('.local')) return true;
  if (h === 'metadata.google.internal') return true;
  if (h === '169.254.169.254') return true; // AWS/Azure IMDS
  return false;
}

export interface UrlValidationOptions {
  /** open_images 인제스트 컨텍스트인 경우 신뢰 호스트 허용. 기본 false (Storage 만). */
  allowOpenImageHosts?: boolean;
}

/**
 * URL 안전성 검증. 실패 시 ApiException(400) throw.
 */
export async function validateImageUrl(
  rawUrl: string,
  options: UrlValidationOptions = {},
): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new ApiException('invalid_url', '잘못된 URL 형식입니다.', 400);
  }

  // 프로토콜
  if (u.protocol !== 'https:') {
    throw new ApiException(
      'unsafe_url_protocol',
      'HTTPS 만 허용됩니다.',
      400,
    );
  }

  // 의심스러운 호스트명
  if (isSuspiciousHostname(u.hostname)) {
    throw new ApiException(
      'unsafe_url_host',
      '내부 호스트로의 접근은 차단되었습니다.',
      400,
    );
  }

  // 사설 IP
  if (isPrivateIpv4(u.hostname) || isPrivateIpv6(u.hostname)) {
    throw new ApiException(
      'unsafe_url_private_ip',
      '사설망 주소는 허용되지 않습니다.',
      400,
    );
  }

  // 사용자 정의 포트 차단 (443 만 허용)
  if (u.port && u.port !== '443' && u.port !== '') {
    throw new ApiException(
      'unsafe_url_port',
      '비표준 포트는 허용되지 않습니다.',
      400,
    );
  }

  // Allowlist
  const supabaseHost = getSupabaseHost();
  const allowed = new Set<string>();
  if (supabaseHost) allowed.add(supabaseHost);
  if (options.allowOpenImageHosts) {
    OPEN_IMAGE_TRUSTED_HOSTS.forEach((h) => allowed.add(h));
  }

  if (allowed.size === 0) {
    throw new ApiException(
      'unsafe_url_no_allowlist',
      '서버에 이미지 호스트 allowlist 가 설정되지 않았습니다.',
      500,
    );
  }

  if (!allowed.has(u.hostname)) {
    throw new ApiException(
      'unsafe_url_not_allowed',
      `허용되지 않은 호스트입니다: ${u.hostname}`,
      400,
    );
  }

  return u;
}

export const OPEN_IMAGE_TRUSTED_HOSTS_EXPORT = OPEN_IMAGE_TRUSTED_HOSTS;
