# Lecture-note generation pipeline handoff

## Branch and commit

- Branch: `codex/naesin-deploy`
- Implementation commit: `2b1c40e Optimize lecture note generation pipeline`
- Base: `origin/main` at `c010403`

Do not deploy this branch before applying migration `00025` and configuring
QStash. Production intentionally rejects generation with HTTP 503 when the
queue is unavailable, preventing another Vercel 300-second stuck job.

## Problem confirmed in production

- `/api/uploads/:id/process` accepted jobs with HTTP 202.
- QStash publishing was disabled because `QSTASH_TOKEN` and the target URL
  were empty.
- Work silently fell back to a Vercel `after()` callback.
- A prior request hit `Vercel Runtime Timeout Error: Task timed out after 300
  seconds`; another upload remained in `processing` indefinitely.

## Implemented

- Durable stages, progress counters, heartbeat, target count, and completed
  question count on `user_uploads`.
- Five-minute cron audit that marks jobs failed after ten minutes without a
  heartbeat.
- Fixed generation slots and unique constraints for retry-safe question and
  image persistence.
- Production queue fail-closed behavior. Inline execution requires the
  explicit emergency flag `ALLOW_INLINE_GENERATION=1`.
- PDF optimization:
  - Direct embedded-image extraction remains preferred.
  - PDFs with embedded candidates skip redundant full-page high-resolution
    rendering.
  - Other text PDFs render all pages at 320px for local candidate selection,
    then render only candidates at high resolution for Vision.
  - Scanned PDFs still render all pages for OCR correctness.
- Vision and OCR progress heartbeats.
- Question generation split into two parallel batches, normally 5 + 5.
- Each batch is persisted immediately; the UI opens the quiz as soon as the
  first five questions are available.
- Retry logic skips already-completed generation slots.
- UI displays concrete stages and progress instead of only `AI processing`.

## Required before deployment

1. Sign in to the Supabase project `sazjdoclofecuhbaobze`.
2. Apply `supabase/migrations/00025_upload_generation_progress.sql`.
3. Sign in to Upstash QStash and obtain the publish token and signing keys.
4. Configure these Vercel Production variables:
   - `QSTASH_TOKEN`
   - `QSTASH_CURRENT_SIGNING_KEY`
   - `QSTASH_NEXT_SIGNING_KEY`
   - `QSTASH_TARGET_URL=https://lecturelink.kro.kr/api/queue/process-upload`
   - `ALLOW_INLINE_GENERATION=0`
5. Deploy the branch after rebasing or merging the latest `origin/main`.

## Verification already completed

- `npm run typecheck`: passed.
- `npm run build`: passed with 58 routes generated.
- The local deploy worktree was installed with lifecycle scripts disabled, so
  page collection printed an existing optional `canvas.node` warning. The
  build still completed successfully. Verify native canvas in the deployed
  worker before testing scanned PDFs.

## Production acceptance test

1. Confirm the previously stuck upload becomes `failed` after migration or
   reset it manually.
2. Upload a 10-30 page text PDF plus reference images.
3. Confirm Vercel logs show a short 202 enqueue request and a signed request to
   `/api/queue/process-upload`.
4. Confirm stage changes: `downloading`, `extracting`, `vision`/`ocr`, then
   `generating`.
5. Confirm five quiz questions appear before the job completes.
6. Confirm answers and explanations remain hidden until submission.
7. Confirm the remaining questions appear and the upload reaches `completed`.
8. Repeat with a scanned PDF and a 100-page mixed PDF.
9. Force one retry and confirm no duplicate questions, images, or quota charge.

## Remaining architectural limitation

The QStash callback still has Vercel `maxDuration = 300`. The PDF optimizations
should bring common documents below that limit, but worst-case 100-page scanned
PDFs may still exceed it. The next hardening step is either a long-running
worker (for example Cloud Run/Railway) or persisted page-batch jobs that each
finish below 300 seconds. Do not claim guaranteed five-minute completion for
all scanned PDFs until that test passes.
