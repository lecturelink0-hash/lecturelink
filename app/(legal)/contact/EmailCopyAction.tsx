"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Mail } from "lucide-react";

type CopyState = "idle" | "copied" | "error";

function copyWithFallback(value: string) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy_failed");
}

export function EmailCopyAction({ email }: { email: string }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    };
  }, []);

  async function copyEmail() {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(email);
      } else {
        copyWithFallback(email);
      }
      setCopyState("copied");
    } catch {
      try {
        copyWithFallback(email);
        setCopyState("copied");
      } catch {
        setCopyState("error");
      }
    }
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 2600);
  }

  return (
    <div className="legal-email-copy-wrap">
      <button
        type="button"
        className="legal-email-copy"
        onClick={copyEmail}
        aria-describedby="contact-email-copy-status"
      >
        <Mail aria-hidden="true" />
        <span>
          <small>이메일 문의</small>
          <strong>{email}</strong>
        </span>
        <span className="legal-email-copy-label">
          {copyState === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copyState === "copied" ? "복사 완료" : "주소 복사"}
        </span>
      </button>
      <p
        id="contact-email-copy-status"
        className={`legal-email-copy-status is-${copyState}`}
        role="status"
        aria-live="polite"
      >
        {copyState === "copied"
          ? "메일 주소가 복사되었어요"
          : copyState === "error"
            ? "복사하지 못했어요. 아래 메일 주소를 직접 복사해 주세요."
            : ""}
      </p>
    </div>
  );
}
