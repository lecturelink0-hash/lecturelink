'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Eye, EyeOff, Trash2 } from 'lucide-react';
import { createBrowserClient } from '@/lib/db/browser';
import { PASSWORD_MAX_LENGTH } from '@/lib/auth/password-policy';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

export function AccountDeletion({ variant = 'default' }: { variant?: 'default' | 'faculty' | 'student' }) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [finalConfirmOpen, setFinalConfirmOpen] = useState(false);
  const idPrefix = useId().replace(/:/g, '');
  const confirmationId = `${idPrefix}-account-deletion-confirmation`;
  const passwordId = `${idPrefix}-account-deletion-password`;
  const errorId = `${idPrefix}-account-deletion-error`;
  const studio = variant !== 'default';
  const isStudent = variant === 'student';

  async function deleteAccount() {
    if (confirmation !== '회원탈퇴' || !password) return;
    setDeleting(true);
    setError('');
    try {
      const response = await fetch('/api/me/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation, password }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message || '회원탈퇴를 완료하지 못했습니다.');
      }
      await createBrowserClient().auth.signOut({ scope: 'local' }).catch(() => undefined);
      window.location.replace('/?account_deleted=1');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '회원탈퇴를 완료하지 못했습니다.');
      setDeleting(false);
    }
  }

  function closeDeletion() {
    if (deleting) return;
    setOpen(false);
    setFinalConfirmOpen(false);
    setConfirmation('');
    setPassword('');
    setPasswordVisible(false);
    setError('');
  }

  if (studio) {
    return (
      <>
        <section className="studio-section card pad professor-danger-panel" aria-labelledby={`${idPrefix}-account-deletion-title`}>
          <div className="professor-danger-heading">
            <span><AlertTriangle size={22} aria-hidden="true" /></span>
            <div>
              <h2 id={`${idPrefix}-account-deletion-title`}>회원탈퇴</h2>
              <p>{isStudent ? '계정과 학습자료는 삭제되며 복구할 수 없습니다.' : '계정과 강의자료는 삭제되며 복구할 수 없습니다.'}</p>
            </div>
          </div>
          <p className="professor-danger-copy">
            관계 법령에 따라 보존할 의무가 있는 거래 기록은 분리 보관 후 파기합니다.{" "}
            <span className="professor-danger-policy-sentence">
              자세한 내용은 <Link href="/privacy">개인정보처리방침</Link>에서 확인할 수 있습니다.
            </span>
          </p>
          {!open ? (
            <button type="button" onClick={() => { setOpen(true); setError(''); }} className="professor-danger-open">
              탈퇴 절차 열기
            </button>
          ) : (
            <div className="professor-danger-form">
              <div className="professor-danger-field">
                <label htmlFor={confirmationId}>확인을 위해 ‘회원탈퇴’를 입력하세요.</label>
                <input
                  id={confirmationId}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
                  disabled={deleting}
                  autoComplete="off"
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? errorId : undefined}
                />
              </div>
              <div className="professor-danger-field">
                <label htmlFor={passwordId}>현재 비밀번호</label>
                <div className="professor-password-input is-danger">
                  <input
                    id={passwordId}
                    type={passwordVisible ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
                    disabled={deleting}
                    maxLength={PASSWORD_MAX_LENGTH}
                    autoComplete="current-password"
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? errorId : undefined}
                    required
                  />
                  <button
                    type="button"
                    className="professor-password-toggle"
                    onClick={() => setPasswordVisible((current) => !current)}
                    aria-label={`탈퇴 확인 비밀번호 ${passwordVisible ? '숨기기' : '보기'}`}
                    aria-pressed={passwordVisible}
                  >
                    {passwordVisible ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}
                  </button>
                </div>
              </div>
              {error && <p id={errorId} role="alert" className="professor-danger-error">{error}</p>}
              <div className="professor-danger-actions">
                <button
                  type="button"
                  onClick={() => { setError(''); setFinalConfirmOpen(true); }}
                  disabled={deleting || confirmation !== '회원탈퇴' || !password}
                  className="professor-danger-delete"
                >
                  <Trash2 size={17} aria-hidden="true" />{deleting ? '삭제 중...' : '영구 삭제'}
                </button>
                <button type="button" onClick={closeDeletion} disabled={deleting} className="professor-danger-cancel">
                  취소
                </button>
              </div>
            </div>
          )}
        </section>
        <ConfirmDialog
          open={finalConfirmOpen}
          title="정말 탈퇴하시겠습니까?"
          description="탈퇴하면 저장된 학습자료, 문제집, 오답노트, CPX 기록 등 계정 데이터가 삭제되며 복구할 수 없습니다."
          confirmLabel="회원탈퇴"
          cancelLabel="취소"
          confirmVariant="secondary"
          cancelVariant="primary"
          loading={deleting}
          error={error || null}
          onCancel={() => { if (!deleting) setFinalConfirmOpen(false); }}
          onConfirm={deleteAccount}
        />
      </>
    );
  }

  return (
    <>
      <section className="mt-8 rounded-2xl border border-red-200 bg-red-50/60 p-5 sm:p-6" aria-labelledby={`${idPrefix}-account-deletion-title`}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-xl bg-white p-2 text-red-700"><AlertTriangle className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <h2 id={`${idPrefix}-account-deletion-title`} className="font-bold text-red-900">회원탈퇴</h2>
          <p className="mt-1 text-sm leading-relaxed text-red-800">
            계정과 학습·강의 자료는 삭제되며 복구할 수 없습니다. 전자상거래법 등 관계 법령에 따라 보존할 의무가 있는 거래 기록은 분리 보관 후 파기합니다.
          </p>
          <p className="mt-2 text-xs text-red-700">
            자세한 내용은 <Link href="/privacy" className="underline">개인정보처리방침</Link>에서 확인할 수 있습니다.
          </p>
          {!open ? (
            <button type="button" onClick={() => { setOpen(true); setError(''); }} className="mt-4 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-800 hover:bg-red-100">
              탈퇴 절차 열기
            </button>
          ) : (
            <div className="mt-4 rounded-xl border border-red-200 bg-white p-4">
              <label className="block text-sm font-semibold text-red-900" htmlFor={confirmationId}>
                확인을 위해 ‘회원탈퇴’를 입력하세요.
              </label>
              <input
                id={confirmationId}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
                disabled={deleting}
                autoComplete="off"
                className="mt-2 h-11 w-full rounded-lg border border-red-200 px-3 text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
              />
              <label className="mt-4 block text-sm font-semibold text-red-900" htmlFor={passwordId}>현재 비밀번호</label>
              <div className="relative mt-2">
                <input
                  id={passwordId}
                  type={passwordVisible ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
                  disabled={deleting}
                  maxLength={PASSWORD_MAX_LENGTH}
                  autoComplete="current-password"
                  className="h-11 w-full rounded-lg border border-red-200 px-3 pr-12 text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                  required
                />
                <button
                  type="button"
                  onClick={() => setPasswordVisible((current) => !current)}
                  aria-label={`탈퇴 확인 비밀번호 ${passwordVisible ? '숨기기' : '보기'}`}
                  aria-pressed={passwordVisible}
                  className="absolute right-0 top-0 grid h-11 w-11 place-items-center rounded-lg text-red-700"
                >
                  {passwordVisible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                </button>
              </div>
              {error && <p id={errorId} role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => { setError(''); setFinalConfirmOpen(true); }}
                  disabled={deleting || confirmation !== '회원탈퇴' || !password}
                  className="inline-flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />{deleting ? '삭제 중...' : '영구 삭제'}
                </button>
                <button type="button" onClick={closeDeletion} disabled={deleting} className="rounded-lg px-4 py-2 text-sm font-semibold text-sage-700">
                  취소
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      </section>
      <ConfirmDialog
        open={finalConfirmOpen}
        title="정말 탈퇴하시겠습니까?"
        description="탈퇴하면 저장된 학습자료, 문제집, 오답노트, CPX 기록 등 계정 데이터가 삭제되며 복구할 수 없습니다."
        confirmLabel="회원탈퇴"
        cancelLabel="취소"
        confirmVariant="secondary"
        cancelVariant="primary"
        loading={deleting}
        error={error || null}
        onCancel={() => { if (!deleting) setFinalConfirmOpen(false); }}
        onConfirm={deleteAccount}
      />
    </>
  );
}
