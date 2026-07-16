/**
 * 오픈 이미지 출처·라이선스 표기 컴포넌트.
 *
 * 의무 사항:
 *   - CC BY / CC BY-SA / PMC OA 이미지 사용 시 attribution_text + license + original_url 노출
 *   - CC0 / public_domain 이미지는 권장이지만 의무 아님
 *   - 빌드 시점에 attribution_text 가 비어 있으면 명시적 경고 (dev only)
 */

import Link from 'next/link';

const LICENSE_LABEL: Record<string, string> = {
  cc0: 'CC0 (저작권 포기)',
  cc_by: 'CC BY',
  cc_by_sa: 'CC BY-SA',
  public_domain: 'Public Domain',
  pmc_oa: 'PMC Open Access',
  nih_open_access: 'NIH Open Access',
};

const LICENSE_URL: Record<string, string> = {
  cc_by: 'https://creativecommons.org/licenses/by/4.0/',
  cc_by_sa: 'https://creativecommons.org/licenses/by-sa/4.0/',
  cc0: 'https://creativecommons.org/publicdomain/zero/1.0/',
  public_domain: 'https://creativecommons.org/publicdomain/mark/1.0/',
};

interface Props {
  attributionText: string;
  license: string;
  originalUrl: string;
  className?: string;
}

export function ImageAttribution({
  attributionText,
  license,
  originalUrl,
  className,
}: Props) {
  // CC0 등 의무 없는 경우라도 출처는 표시 (UX 신뢰도)
  if (!attributionText || !originalUrl) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        '[ImageAttribution] attribution_text 또는 original_url 누락. 라이선스 의무 위반 가능성:',
        { attributionText, license, originalUrl },
      );
    }
    return null;
  }

  const licenseLabel = LICENSE_LABEL[license] ?? license;
  const licenseUrl = LICENSE_URL[license];

  return (
    <div
      className={
        'text-[10px] text-[var(--color-muted)] leading-tight mt-1 ' + (className ?? '')
      }
    >
      <span className="opacity-80">© </span>
      <Link
        href={originalUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-sage-700"
      >
        {attributionText}
      </Link>
      <span className="mx-1">·</span>
      {licenseUrl ? (
        <Link
          href={licenseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-sage-700"
        >
          {licenseLabel}
        </Link>
      ) : (
        <span>{licenseLabel}</span>
      )}
    </div>
  );
}
