ALLOWANCE-RESUME REVIEW: r72-article-page, branch claude/allowance-resume, cf45a50e676c022bcc600928cc75ba60e48cc8f2 against c00c928

VERDICT: SHIP. I found no way to spend beyond the allowance or twice for one article; the write-time budget check is unchanged and remains the gate. One should-fix (A1) is a page promise that fails without cost.

I confirmed HEAD is cf45a50 on claude/allowance-resume and `git status --short` is empty before and after. Nothing in the worktree was edited; no database or live service was touched.

Scratch scripts are in /tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/article-review/r6/ (money.test.mts, rest.test.mts, shell.test.mts, golden-base.json.gz, golden-head.json.gz, full-unset.log, full-enabled.log), reusing r2/h.mts and r5/pub.test.mts, r5/back.test.mts. Line references are under /home/user/r72-article-page/orchestrator/.

====================================================================
TEST RESULTS (ran)
====================================================================
- `npx tsc --noEmit -p .`: exit 0.
- seo-blog-allowance-resume 12/12; article-page 8/8, round2 15/15, round3 9/9, followups 10/10; seo-blog-portal 9/9; seo-blog-promotions 8/8; content-area-shell 8/8, round2 8/8, round3 7/7, round4 8/8; 0 cancelled in each.
- Full `npm test` with CONTENT_AREA_PREVIEW unset: 5052 tests, 4939 pass, 0 fail, 0 cancelled, 113 skipped (569 s, no other runner at start).
- Full `npm test` with CONTENT_AREA_PREVIEW=enabled: 5052 tests, 4939 pass, 0 fail, 0 cancelled, 113 skipped (363 s; other runners appeared during it).

====================================================================
SHOULD-FIX
====================================================================

A1. "Write it now" is offered while something else still stops the write.
- Where: `writingStatus()` in src/portal/seo-blog-article-view.ts. "Cleared" is judged on the job's own cause only; an allowance stop does not look at the pause switch.
- Ran (rest.test.mts): job stopped for allowance, allowance then made unlimited, business paused.
  - Article page and list: "It stopped because the writing allowance ran out. There is enough now." with "Write it now".
  - Press: "Trying again. The article carries on being written; you can leave this page."
  - Worker pass: job blocked again with "Draft production is paused by the owner."; 0 model calls; no article.
- Nothing is spent, and the next page view then says writing is paused. It is one wasted press on a promise the page should not make.
- Read only: the same would apply to an allowance stop with details unconfirmed or the writing service not connected.
- Fix: offer the button only when every condition holds (not paused, details confirmed, service connected, allowance fits).

====================================================================
1. MONEY (ran unless marked)
====================================================================
- The estimate is one constant: 32,000 (`USAGE_ESTIMATES.article`), used by the resume and by the write path's `requireBudget` (read, engine.ts:1476 and the resume).
- Unlimited both ways: a null operator limit resumes the job; a ceiling of Number.MAX_SAFE_INTEGER resumes it. A ceiling of 0 does not.
- Boundary: one token short of the estimate resumes 0; exactly the estimate resumes 1.
- Three waiting, room for two by estimate, two saves at once: "resumed 2 and 1", so all three were queued.
  - Each job is requeued once (the row-version check held), but the two passes do not see each other's count.
  - All three were then written: used 100,800 of a 154,000 ceiling, 6 model calls. The scripted model uses far fewer tokens than the estimate.
  - With real usage near the estimate, the third would stop again at the write-time check. I count this as a note, not overspend.
- Afterwards: five more worker passes, a daily pass, another owner save and three more passes gave 0 new model calls and unchanged usage.
- Unknown result: with a copy step started and no receipt, the save resumed 0, the worker pass left it blocked, and the owner's retry was refused ("…uncertain outcome. Retry cannot…").
- Retry press, save and worker pass together: one requeue ("queued | resumed 0 | tick ok"); afterwards one article with one version.
- Stale rewrites (read only, engine.ts:1464): a waiting rewrite whose article has moved on returns without spending. An already-written article only finishes bookkeeping (engine.ts:1457).
- The resume only requeues. Every run still passes `requireBudget` before any model call.

====================================================================
2. LOOPS AND STORMS
====================================================================
- Wake-up task (ran): kind `daily`, key `allowance-wake:2026-12`, runs 2026-12-01T00:00Z. One per business per month.
  - Ceiling below one article: after December, January and February there were 4 wake tasks in all, one per month, and the job never ran.
- Paused on the 1st (ran): the wake ran and did nothing, and no new wake was scheduled. After unpausing, three worker passes left the job blocked.
  - The page says "There is enough now" with "Write it now", so the owner has a way forward, but nothing automatic remains for that job. Unconfirmed details at the turn of the month behave the same way (read only).
- The stamp (read only): a worker or daily pass skips a job already stamped this month; the owner's save and the month wake ignore it; the owner's Retry keeps the payload, so the stamp survives.
- Cost per pass (ran, 50 active businesses with 10 waiting writes each, in memory):
  - 399 store calls in 22 ms on the first pass; 352 on the second.
  - The new loop adds `getBrand` and `listJobs` for every active business on every pass, plus `latestProfile` and `listKnowledge` for each business whose waiting writes cannot resume. Those are re-read every pass, because only a requeue sets the stamp.
  - The default pass interval is 60 s (src/workers/seo-blog/cli.ts:38).
- The loop runs before jobs are claimed, so it cannot eat a lease; it only delays the pass.
- Isolation (ran): with one business's job read throwing, the pass completed ("jobs 0, businesses 50").
- Read only:
  - The loop takes the first 50 of an unordered active list.
  - In Postgres any queued job makes a business "active" (migration 0131), so the wake task itself keeps a business with a waiting write visited all month.
  - `listJobs` in Postgres returns the newest 200 jobs (pg-store.ts:676), so a waiting write older than that is invisible to the resume and to the page.

====================================================================
3. AUTHORISATION AND TENANCY
====================================================================
- Another user calling `resumeAllowanceBlockedWrites` (ran): refused 404 "That brand was not found."
- Limits page (read only, router): it calls the same method as the signed-in user and swallows a refusal, so a founder who does not manage that business resumes nothing there. I did not run this path; the fixture has no limits service.
- No write on GET (ran):
  - 11 classic pages for a business with a waiting, resumable write (home, overview, articles, the article, its edit view, topics, calendar, publishing, activity, dna, setup): 232 store calls, none mutating; jobs byte-identical afterwards.
  - With the new look on (environment switch plus cookie), Home, Articles and the article page also made no mutating call.

====================================================================
4. TRUTHFULNESS (ran: page, then the button, then three worker passes)
====================================================================

| State | Article page and list | Button | After press and worker |
|---|---|---|---|
| Allowance still short | Paused: waiting for more writing allowance this month | Check the allowance | still blocked, 0 calls |
| Allowance unlimited | It stopped because the writing allowance ran out. There is enough now | Write it now | written |
| Allowance raised | same | Write it now | written |
| Ceiling 0 | Paused: waiting… | Check the allowance | still blocked |
| Enough alone, another queued first | Other articles are being written first… | none | still blocked, 0 calls |
| Enough, business paused | "There is enough now" | Write it now | blocked again for the pause (A1) |
| Details now confirmed | It stopped because your business details needed confirming. They are confirmed now | Write it now | written |
| Details still unconfirmed | Paused: waiting for you to confirm your business details | Confirm your details | still blocked |
| Pause lifted | It stopped because writing was paused. Writing is switched back on now | Write it now | written |
| Still paused | Paused: writing is paused for your business | Open publishing settings | still blocked |
| Service connected now | It stopped because the writing service was not connected. It is connected now | Write it now | written |
| Unknown result | Paused: the last writing step did not confirm its result… | See what happened | still blocked |
| Out-of-date plan | Paused: its plan is out of date… | Open Topics | still blocked |

- "Service still not connected" I did not run through the router; the builder's shell fixtures cover it.
- New look (ran, shell.test.mts): Home, Articles and the article page showed the same sentence and button in both the short and the unlimited state.

====================================================================
5. GOLDEN ENTRIES AND FIXTURES (ran: my own decode and diff of both golden files)
====================================================================
- 245 entries in both; no keys added or removed.
- 2 entries differ, not 3: `stopped:articles` and `stopped:article-13`. Every difference is the waiting sentence becoming "It stopped because the writing allowance ran out. There is enough now", the retry form and the content length.
- The other 243 entries are byte-identical, so the preview-off pages are otherwise unchanged against c00c928.
- Fixture edits: usage set to 2,000,000 to keep the "still no allowance" scenarios, and `generation: 'unavailable'` to keep "service not connected". Both follow from the page now reading current facts.

====================================================================
6. S1 (ran: r5/pub.test.mts and r5/back.test.mts on this build)
====================================================================
- Source marked not shown to readers, or removed from the list, then the sentence changed back: "1 sentence you changed back could not get its source back, because that source is no longer shown in this article." No marker restored; checks critical.
- The normal change-back still restores, byte-identical, with checks back to warnings.

====================================================================
NOTES
====================================================================
- Writes resume by themselves at the new month and on a worker pass, within the allowance. The waiting page does not say that it will restart on its own.
- Waiting rewrites are resumed too, but the page logic only covers first writes.

====================================================================
THE KNOWN LIMIT
====================================================================
Acceptable to ship with. The page tells the truth and offers "Write it now", and the owner's save resumes. In Postgres the queued wake task also keeps the business visited by the worker for the month (read only). The one gap I found is a business paused or unconfirmed at the turn of the month: its wake is used up and not renewed, so that job then waits for the button or a save.

====================================================================
RECOMMENDED FOLLOW-UPS
====================================================================
1. A1: offer "Write it now" only when nothing else would stop the write.
2. Renew the wake-up task when the month's pass is skipped for a pause or unconfirmed details.
3. Have the resume and the page read waiting writes directly, not from the newest 200 jobs.
4. Skip the per-pass re-read for businesses whose waiting writes could not resume last time.