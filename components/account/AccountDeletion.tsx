'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { createBrowserClient } from '@/lib/db/browser';

export function AccountDeletion() {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  async function deleteAccount() {
    if (confirmation !== '회원탈퇴') return;
    setDeleting(true);
    setError('');
    try {
      const response = await fetch('/api/me/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation }),
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

  return (
    <section className="mt-8 rounded-2xl border border-red-200 bg-red-50/60 p-5 sm:p-6" aria-labelledby="account-deletion-title">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-xl bg-white p-2 text-red-700"><AlertTriangle className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <h2 id="account-deletion-title" className="font-bold text-red-900">회원탈퇴</h2>
          <p className="mt-1 text-sm leading-relaxed text-red-800">
            계정과 학습·강의 자료는 삭제되며 복구할 수 없습니다. 전자상거래법 등 관계 법령에 따라 보존할 의무가 있는 거래 기록은 분리 보관 후 파기합니다.
          </p>
          <p className="mt-2 text-xs text-red-700">
            자세한 내용은 <Link href="/privacy" className="underline">개인정보처리방침</Link>에서 확인할 수 있습니다.
          </p>
          {!open ? (
            <button type="button" onClick={() => setOpen(true)} className="mt-4 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-800 hover:bg-red-100">
              탈퇴 절차 열기
            </button>
          ) : (
            <div className="mt-4 rounded-xl border border-red-200 bg-white p-4">
              <label className="block text-sm font-semibold text-red-900" htmlFor="account-deletion-confirmation">
                확인을 위해 ‘회원탈퇴’를 입력하세요.
              </label>
              <input
                id="account-deletion-confirmation"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={deleting}
                autoComplete="off"
                className="mt-2 h-11 w-full rounded-lg border border-red-200 px-3 text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
              />
              {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={deleteAccount}
                  disabled={deleting || confirmation !== '회원탈퇴'}
                  className="inline-flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />{deleting ? '삭제 중...' : '영구 삭제'}
                </button>
                <button type="button" onClick={() => { setOpen(false); setConfirmation(''); setError(''); }} disabled={deleting} className="rounded-lg px-4 py-2 text-sm font-semibold text-sage-700">
                  취소
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
