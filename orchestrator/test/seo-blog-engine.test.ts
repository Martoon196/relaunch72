import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { UnconfiguredSearchProvider } from '../src/seo-blog/research.js';
import type { Brand } from '../src/seo-blog/types.js';
import { harness, makeDocx, makePdf, OWNER, seedBrandSite, STRANGER, type Harness } from './seo-blog-fixtures.js';

const BUDGETS = { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 };

async function readyBrand(h: Harness, name: string, origin: string, topic: string): Promise<Brand> {
  seedBrandSite(h.web, origin, topic);
  const { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name, website: origin });
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from(`${name} Compliance Plan costs £49 per month.`) });
  const profile = await h.engine.extractBrandProfile(OWNER, brand.id).catch(async (e) => {
    // Budgets start at zero: the first extraction must be refused until the owner sets them.
    assert.equal((e as { code?: string }).code, 'budget_exceeded');
    const b = await h.engine.getBrand(OWNER, brand.id);
    await h.engine.updateSettings(OWNER, brand.id, b.rowVersion, { budgets: BUDGETS });
    return h.engine.extractBrandProfile(OWNER, brand.id);
  });
  await h.engine.confirmProfile(OWNER, brand.id, profile.version);
  return h.engine.getBrand(OWNER, brand.id);
}

async function planAndWrite(h: Harness, brand: Brand, count = 3) {
  await h.engine.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await h.engine.tick('worker-1');
  const [{ plan, briefs }] = await h.engine.listPlans(OWNER, brand.id) as [{ plan: import('../src/seo-blog/types.js').TopicPlan; briefs: import('../src/seo-blog/types.js').ArticleBrief[] }];
  await h.engine.acceptPlan(OWNER, brand.id, plan.id);
  const chosen = [briefs.find((b) => b.role === 'pillar')!, ...briefs.filter((b) => b.role === 'supporting' && b.status === 'planned').slice(0, count - 1)];
  await h.engine.requestArticles(OWNER, brand.id, chosen.map((b) => b.id));
  await h.engine.tick('worker-1');
  const articles = await h.engine.listArticles(OWNER, brand.id);
  return { plan, briefs, chosen, articles };
}

async function connectGithub(h: Harness, brand: Brand) {
  return h.engine.connectDestination(OWNER, brand.id, {
    type: 'github_static', label: 'Website', credential: 'gh-token-1',
    config: { repository: 'acme/site', branch: 'main', publicBaseUrl: 'https://harbour.example', blogPath: 'blog', sitemapPath: 'sitemap.xml' },
  });
}

test('A1: Add brand creates separate workspaces; a retried command does not duplicate; strangers cannot see them', async () => {
  const h = harness();
  const command = randomUUID();
  const first = await h.engine.createBrand(OWNER, { commandId: command, name: 'Harbour Lettings', website: 'harbour.example' });
  const retry = await h.engine.createBrand(OWNER, { commandId: command, name: 'Harbour Lettings', website: 'harbour.example' });
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.brand.id, first.brand.id);
  const second = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Bay Property Club' });
  assert.notEqual(second.brand.id, first.brand.id);
  assert.equal(first.brand.website, 'https://harbour.example');
  assert.equal(second.brand.website, null);
  assert.deepEqual((await h.engine.listBrands(OWNER)).map((b) => b.name), ['Bay Property Club', 'Harbour Lettings']);
  assert.equal(first.brand.settings.autoPublish, false, 'new brands start with automatic publishing off');
  assert.equal(first.brand.settings.ongoingProduction, false);
  assert.equal(first.brand.timezone, 'Europe/London');
  assert.equal(first.brand.locale, 'en-GB');
  // Foreign-brand access is indistinguishable from a missing brand.
  await assert.rejects(h.engine.getBrand(STRANGER, first.brand.id), { status: 404 });
  await assert.rejects(h.engine.uploadKnowledge(STRANGER, first.brand.id, { category: 'faqs', title: 'x', pastedText: 'x' }), { status: 404 });
  assert.deepEqual(await h.engine.listBrands(STRANGER), []);
  // Separate knowledge per brand.
  await h.engine.uploadKnowledge(OWNER, first.brand.id, { category: 'voice_samples', title: 'Voice', pastedText: 'Plain and friendly.' });
  assert.equal((await h.engine.listKnowledge(OWNER, first.brand.id)).length, 1);
  assert.equal((await h.engine.listKnowledge(OWNER, second.brand.id)).length, 0);
});

test('A1/A11: uploads report exactly what was read, including unreadable and rejected files', async () => {
  const h = harness();
  const { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Upload Test' });
  const docx = await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'brand_guidelines', title: 'Guide', filename: 'guide.docx', bytes: makeDocx(['Always write in plain English.', 'Never promise returns.']) });
  assert.equal(docx.status, 'extracted');
  assert.match(docx.text!, /plain English[\s\S]*Never promise returns/);
  const pdf = await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'faqs', title: 'FAQ', filename: 'faq.pdf', bytes: makePdf(['BT /F1 12 Tf 72 712 Td (Our support team answers within one working day.) Tj ET', null]) });
  assert.equal(pdf.status, 'partial');
  assert.equal(pdf.pagesRead, 1);
  assert.equal(pdf.pagesTotal, 2);
  assert.match(pdf.statusDetail, /1 of 2 pages[\s\S]*OCR is not available/);
  const scanned = await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'faqs', title: 'Scan', filename: 'scan.pdf', bytes: makePdf([null]) });
  assert.equal(scanned.status, 'unreadable');
  assert.equal(scanned.text, null);
  const exe = await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'other', title: 'Bad', filename: 'tool.exe', bytes: Buffer.from([0x4d, 0x5a, 0, 1, 2]) });
  assert.equal(exe.status, 'unsupported');
  assert.equal(exe.active, false);
  const png = await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'visual_guidance', title: 'Logo', filename: 'logo.png', bytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]) });
  assert.equal(png.status, 'image_reference');
  assert.equal(png.text, null);
  const readiness = await h.engine.readiness(OWNER, brand.id);
  assert.equal(readiness.unreadableKnowledge, 1);
  assert.equal(readiness.canPlan, false);
});

test('A2: with no topic supplied, each brand gets its own researched cluster with dates and duplicate checks', async () => {
  const h = harness();
  const harbour = await readyBrand(h, 'Harbour Lettings', 'https://harbour.example', 'deposits');
  const bay = await readyBrand(h, 'Bay Property Club', 'https://bay.example', 'deposits');
  for (const brand of [harbour, bay]) {
    await h.engine.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  }
  await h.engine.tick('worker-1');
  for (const brand of [harbour, bay]) {
    const plans = await h.engine.listPlans(OWNER, brand.id);
    assert.equal(plans.length, 1);
    const { plan, briefs } = plans[0]!;
    assert.equal(briefs.length, 7);
    assert.equal(briefs.filter((b) => b.role === 'pillar').length, 1);
    assert.ok(plan.sources.length >= 2);
    assert.ok(plan.sources.some((s) => s.primary && s.url.includes('gov.uk')), 'primary sources are preferred');
    assert.ok(plan.sources.every((s) => s.passage.length > 40 && s.retrievedAt));
    for (const b of briefs) {
      assert.equal(b.demand.kind, 'qualitative', 'no paid keyword data: demand is honestly qualitative');
      assert.ok(b.whyFit.length > 10);
      assert.ok(b.sourceIds.length > 0);
    }
    const dup = briefs.find((b) => b.slug.startsWith('deposits-basics-for-landlords'))!;
    assert.equal(dup.duplicate.verdict, 'update_existing');
    assert.equal(dup.status, 'postponed');
    assert.match(dup.duplicate.against!, /\/guides\/deposits-basics$/);
    const pillar = briefs.find((b) => b.role === 'pillar')!;
    const dated = briefs.filter((b) => b.suggestedAtUtc);
    assert.ok(dated.length >= 3);
    for (const b of dated) if (b.role === 'supporting') assert.ok(b.suggestedAtUtc! > pillar.suggestedAtUtc!, 'pillar is scheduled before supporting articles');
  }
  // Planned posts participate in duplicate checks: a second plan for the same brand cannot reuse slugs/topics silently.
  h.clock.advance(60_000);
  await h.engine.requestPlan(OWNER, harbour.id, { commandId: randomUUID() });
  await h.engine.tick('worker-1');
  const plansNow = await h.engine.listPlans(OWNER, harbour.id);
  assert.equal(plansNow.length, 2);
  const second = plansNow[0]!;
  assert.ok(second.briefs.every((b) => b.duplicate.verdict !== 'distinct'), 'the repeated cluster is flagged against the planned one');
  assert.ok(second.briefs.every((b) => !b.slug.match(/^tenancy-deposit-protection-guide$/)));
});

test('A3/A4: complete articles with sources and links; section regeneration keeps other sections and history', async () => {
  const h = harness();
  const brand = await readyBrand(h, 'Harbour Lettings', 'https://harbour.example', 'deposits');
  const { articles } = await planAndWrite(h, brand, 3);
  assert.equal(articles.length, 3);
  const detail = await h.engine.getArticle(OWNER, brand.id, articles[0]!.article.id);
  const v1 = detail.version!;
  assert.equal(v1.number, 1);
  assert.equal(v1.generation?.mode, 'simulated', 'scripted model output is recorded as simulated');
  assert.ok(v1.body.sections.length >= 3);
  assert.ok(v1.body.citations.some((c) => c.public && c.url.includes('gov.uk')));
  assert.match(v1.body.sections[0]!.body, /\[src:[0-9a-f-]{36}\]/);
  assert.equal(detail.article.checks?.status, 'warnings', JSON.stringify(detail.article.checks?.issues));
  assert.ok(detail.article.checks!.issues.every((i) => i.severity === 'warning'));
  const preview = await h.engine.preview(OWNER, brand.id, detail.article.id);
  assert.match(preview, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(preview, /href="https:\/\/harbour\.example\/guides\/deposits-basics"/);
  assert.match(preview, /<sup><a href="#source-1">\[1\]<\/a><\/sup>/);

  // Approve, then regenerate one section: approval resets, only that section changes, v1 remains.
  await h.engine.approve(OWNER, brand.id, detail.article.id, v1.id);
  const target = v1.body.sections[1]!;
  const v2 = await h.engine.regenerateSection(OWNER, brand.id, detail.article.id, v1.id, target.id, 'Make it more practical.');
  assert.equal(v2.number, 2);
  assert.equal(v2.parentVersionId, v1.id);
  assert.equal(v2.change, 'section_regenerated');
  assert.equal(v2.changedSectionId, target.id);
  assert.match(v2.body.sections[1]!.body, /^Rewritten section/);
  assert.deepEqual(v2.body.sections[0], v1.body.sections[0]);
  assert.deepEqual(v2.body.sections[2], v1.body.sections[2]);
  assert.equal(v2.body.intro, v1.body.intro);
  const reloaded = await h.engine.getArticle(OWNER, brand.id, detail.article.id);
  assert.equal(reloaded.article.approval, null, 'an edit invalidates the old approval');
  assert.equal(reloaded.versions.length, 2);
  assert.equal(reloaded.versions[0]!.body.sections[1]!.body, target.body, 'the earlier version is preserved unchanged');
  assert.equal(reloaded.article.checks?.versionId, v2.id, 'checks reran on the new version');
  // A stale editor cannot overwrite the newer version.
  await assert.rejects(h.engine.editArticle(OWNER, brand.id, detail.article.id, v1.id, { title: 'Late edit' }), { code: 'stale_write' });
});

test('A11: an unsupported figure is a critical issue that approval cannot override', async () => {
  const h = harness();
  const brand = await readyBrand(h, 'Harbour Lettings', 'https://harbour.example', 'deposits');
  const { articles } = await planAndWrite(h, brand, 1);
  const { article, version } = await h.engine.getArticle(OWNER, brand.id, articles[0]!.article.id);
  const v2 = await h.engine.editArticle(OWNER, brand.id, article.id, version!.id, {
    sections: version!.body.sections.map((s, i) => (i === 2 ? { ...s, body: `${s.body} Landlords who use us see 37% fewer disputes and our clients have achieved better results.` } : s)),
  });
  const after = await h.engine.getArticle(OWNER, brand.id, article.id);
  assert.equal(after.article.checks?.status, 'critical');
  assert.ok(after.article.checks!.issues.some((i) => i.code === 'facts.unsupported_figure' && i.message.includes('37%')));
  assert.ok(after.article.checks!.issues.every((i) => i.fix.length > 5), 'every issue offers a practical fix');
  await assert.rejects(h.engine.approve(OWNER, brand.id, article.id, v2.id), { code: 'checks_failed' });
  // A fabricated quotation and an outcome promise are also critical.
  const v3 = await h.engine.editArticle(OWNER, brand.id, article.id, v2.id, {
    sections: version!.body.sections.map((s, i) => (i === 2 ? { ...s, body: `${s.body} As one landlord told us, "this changed everything about how I let my flat". We guarantee you will make more money.` } : s)),
  });
  const codes = (await h.engine.getArticle(OWNER, brand.id, article.id)).article.checks!.issues.map((i) => i.code);
  assert.ok(codes.includes('facts.quote_fabricated'));
  assert.ok(codes.includes('claims.misleading_promise'));
  assert.ok(v3.number === 3);
});

test('A5: diary times persist as brand-local intent with correct Europe/London DST conversion', async () => {
  const h = harness('2026-03-01T10:00:00.000Z');
  const brand = await readyBrand(h, 'Harbour Lettings', 'https://harbour.example', 'deposits');
  const { articles } = await planAndWrite(h, brand, 2);
  const destination = await connectGithub(h, brand);
  assert.equal(destination.status, 'connected', destination.statusDetail);
  const [a, b] = articles.map((x) => x.article);
  // Summer time (BST, UTC+1).
  let s = await h.engine.schedule(OWNER, brand.id, a!.id, (await h.store.getArticle(brand.id, a!.id))!.rowVersion, { localDate: '2026-04-14', localTime: '09:00', destinationId: destination.id });
  assert.equal(s.schedule!.publishAtUtc, '2026-04-14T08:00:00.000Z');
  // Winter time (GMT, UTC+0) — moving the card is an ordinary form/keyboard-equivalent reschedule.
  s = await h.engine.schedule(OWNER, brand.id, a!.id, s.rowVersion, { localDate: '2026-03-17', localTime: '09:00', destinationId: destination.id });
  assert.equal(s.schedule!.publishAtUtc, '2026-03-17T09:00:00.000Z');
  // Spring-forward gap: 01:30 does not exist on 29 March 2026 and is moved forward, visibly.
  const gap = await h.engine.schedule(OWNER, brand.id, b!.id, (await h.store.getArticle(brand.id, b!.id))!.rowVersion, { localDate: '2026-03-29', localTime: '01:30', destinationId: destination.id });
  assert.equal(gap.schedule!.publishAtUtc, '2026-03-29T01:30:00.000Z');
  assert.equal(gap.schedule!.localTime, '02:30');
  // Reload from the store: date, time, timezone and destination persist.
  const reloaded = (await h.store.getArticle(brand.id, a!.id))!;
  assert.deepEqual([reloaded.schedule!.localDate, reloaded.schedule!.localTime, reloaded.schedule!.timezone, reloaded.schedule!.destinationId], ['2026-03-17', '09:00', 'Europe/London', destination.id]);
  // Past times are refused rather than published late.
  await assert.rejects(h.engine.schedule(OWNER, brand.id, a!.id, reloaded.rowVersion, { localDate: '2026-02-01', localTime: '09:00', destinationId: destination.id }), { status: 400 });
});

async function scheduledArticle(h: Harness, opts: { autoPublish: boolean; requiresApproval: boolean; approve: boolean }) {
  const brand = await readyBrand(h, 'Harbour Lettings', 'https://harbour.example', 'deposits');
  const { articles } = await planAndWrite(h, brand, 1);
  const destination = await connectGithub(h, brand);
  let b = await h.engine.getBrand(OWNER, brand.id);
  b = await h.engine.updateSettings(OWNER, brand.id, b.rowVersion, { autoPublish: opts.autoPublish });
  const id = articles[0]!.article.id;
  let article = (await h.store.getArticle(brand.id, id))!;
  if (opts.requiresApproval) article = await h.engine.setRequiresApproval(OWNER, brand.id, id, article.rowVersion, true);
  if (opts.approve) article = await h.engine.approve(OWNER, brand.id, id, article.currentVersionId!);
  article = await h.engine.schedule(OWNER, brand.id, id, article.rowVersion, { localDate: '2026-11-03', localTime: '09:00', destinationId: destination.id });
  return { brand: b, id, destination };
}

test('A6/A8: every publishing-policy row behaves as specified, and publication is verified on the public page', async () => {
  const rows: { autoPublish: boolean; requiresApproval: boolean; approve: boolean; expect: 'Published' | 'Held' }[] = [
    { autoPublish: false, requiresApproval: false, approve: true, expect: 'Published' },
    { autoPublish: false, requiresApproval: false, approve: false, expect: 'Held' },
    { autoPublish: true, requiresApproval: false, approve: false, expect: 'Published' },
    { autoPublish: true, requiresApproval: true, approve: false, expect: 'Held' },
    { autoPublish: true, requiresApproval: true, approve: true, expect: 'Published' },
  ];
  for (const row of rows) {
    const h = harness();
    const { brand, id } = await scheduledArticle(h, row);
    h.clock.set('2026-11-03T09:00:30.000Z');
    await h.engine.tick('worker-1');
    const detail = await h.engine.getArticle(OWNER, brand.id, id);
    assert.equal(detail.status, row.expect, `row ${JSON.stringify(row)}: ${detail.article.hold?.detail ?? detail.article.failure}`);
    if (row.expect === 'Held') {
      assert.equal(detail.article.hold?.reason, 'missing_approval');
      assert.equal(h.github.refPatches, 0, 'nothing was sent to the website');
      // Late approval does not publish immediately: the owner must choose a new time.
      await h.engine.approve(OWNER, brand.id, id, detail.article.currentVersionId!);
      h.clock.advance(60_000);
      await h.engine.tick('worker-1');
      assert.equal((await h.engine.getArticle(OWNER, brand.id, id)).status, 'Held');
      assert.equal(h.github.refPatches, 0);
    } else {
      const pub = detail.publications[0]!;
      assert.equal(pub.state, 'published');
      assert.equal(pub.policy.rule, row.autoPublish && !row.requiresApproval ? 'auto_unflagged' : 'approved');
      assert.equal(pub.versionId, detail.article.currentVersionId);
      const files = h.github.files();
      const slug = detail.version!.body.slug;
      const page = files.get(`blog/${slug}/index.html`)!;
      assert.match(page, new RegExp(`<link rel="canonical" href="https://harbour\\.example/blog/${slug}/">`));
      assert.match(page, /<meta name="robots" content="index, follow">/);
      assert.match(page, /<h1>[^<]+<\/h1>/);
      assert.equal((page.match(/<h1>/g) ?? []).length, 1);
      assert.match(files.get('blog/index.html')!, new RegExp(`href="https://harbour\\.example/blog/${slug}/"`));
      const sitemap = files.get('sitemap.xml')!;
      assert.match(sitemap, /<loc>https:\/\/harbour\.example\/<\/loc>/, 'existing sitemap entries are preserved');
      assert.match(sitemap, new RegExp(`<loc>https://harbour\\.example/blog/${slug}/</loc>`));
      assert.ok(detail.article.publishedAt && pub.firstAttemptAt, 'attempted and verified times are both recorded');
    }
  }
});

test('A6: pause holds approved work; turning auto publish off holds unapproved work; overdue work is not replayed', async () => {
  {
    const h = harness();
    const { brand, id } = await scheduledArticle(h, { autoPublish: false, requiresApproval: false, approve: true });
    const b = await h.engine.getBrand(OWNER, brand.id);
    await h.engine.updateSettings(OWNER, brand.id, b.rowVersion, { pauseAll: true });
    h.clock.set('2026-11-03T09:00:30.000Z');
    await h.engine.tick('worker-1');
    const d = await h.engine.getArticle(OWNER, brand.id, id);
    assert.equal(d.article.hold?.reason, 'paused');
    assert.equal(h.github.refPatches, 0);
  }
  {
    const h = harness();
    const { brand, id } = await scheduledArticle(h, { autoPublish: true, requiresApproval: false, approve: false });
    const b = await h.engine.getBrand(OWNER, brand.id);
    await h.engine.updateSettings(OWNER, brand.id, b.rowVersion, { autoPublish: false });
    h.clock.set('2026-11-03T09:00:30.000Z');
    await h.engine.tick('worker-1');
    assert.equal((await h.engine.getArticle(OWNER, brand.id, id)).article.hold?.reason, 'missing_approval');
  }
  {
    // The worker was down for a day: the slot is missed and held, not published in a burst.
    const h = harness();
    const { brand, id } = await scheduledArticle(h, { autoPublish: true, requiresApproval: false, approve: false });
    h.clock.set('2026-11-04T12:00:00.000Z');
    await h.engine.tick('worker-1');
    const d = await h.engine.getArticle(OWNER, brand.id, id);
    assert.equal(d.article.hold?.reason, 'missed_window');
    assert.equal(h.github.refPatches, 0);
  }
});

test('A7: a version edited while the job waits is held, never published stale or unapproved', async () => {
  const h = harness();
  const { brand, id } = await scheduledArticle(h, { autoPublish: false, requiresApproval: false, approve: true });
  const before = await h.engine.getArticle(OWNER, brand.id, id);
  await h.engine.editArticle(OWNER, brand.id, id, before.version!.id, { title: 'Tenancy deposit protection: an updated landlord guide' });
  h.clock.set('2026-11-03T09:00:30.000Z');
  await h.engine.tick('worker-1');
  const after = await h.engine.getArticle(OWNER, brand.id, id);
  assert.equal(after.article.hold?.reason, 'missing_approval', 'the approval was for the earlier version');
  assert.equal(after.publications.length, 0);
  assert.equal(h.github.refPatches, 0);
});

test('A9: a lost provider response is reconciled; duplicate workers create one publication and one site entry', async () => {
  const h = harness();
  const { brand, id } = await scheduledArticle(h, { autoPublish: true, requiresApproval: false, approve: false });
  h.clock.set('2026-11-03T09:00:30.000Z');
  h.github.dropNextRefResponse = true; // the commit lands but the response is lost
  const second = h.makeEngine();
  await Promise.all([h.engine.dispatchDue(brand.id), second.dispatchDue(brand.id)]);
  let detail = await h.engine.getArticle(OWNER, brand.id, id);
  assert.equal(detail.publications.length, 1, 'one operation for the exact version');
  assert.ok(['outcome_unknown', 'published', 'verifying'].includes(detail.publications[0]!.state));
  h.clock.advance(60_000);
  await h.engine.reconcile(brand.id);
  detail = await h.engine.getArticle(OWNER, brand.id, id);
  assert.equal(detail.publications[0]!.state, 'published', detail.publications[0]!.detail);
  assert.equal(detail.status, 'Published');
  assert.equal(h.github.refPatches, 1, 'the article was committed exactly once');
  const index = h.github.files().get('blog/index.html')!;
  assert.equal((index.match(/<article>/g) ?? []).length, 1, 'one index entry');
  const sitemap = h.github.files().get('sitemap.xml')!;
  assert.equal((sitemap.match(new RegExp(detail.version!.body.slug, 'g')) ?? []).length, 1, 'one sitemap entry');
});

test('A9: a concurrent site edit is never overwritten', async () => {
  const h = harness();
  const { brand, id } = await scheduledArticle(h, { autoPublish: true, requiresApproval: false, approve: false });
  h.github.concurrentEditOnce = true;
  h.clock.set('2026-11-03T09:00:30.000Z');
  await h.engine.tick('worker-1');
  assert.equal((await h.engine.getArticle(OWNER, brand.id, id)).status, 'Published');
  assert.equal(h.github.files().get('about.html'), '<p>edited by a human</p>', 'the human edit survived');
});

test('A10: restarts during writing and publication resume without duplicates or surprise publication', async () => {
  const h = harness();
  const brand = await readyBrand(h, 'Harbour Lettings', 'https://harbour.example', 'deposits');
  await h.engine.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await h.engine.tick('worker-1');
  const { plan, briefs } = (await h.engine.listPlans(OWNER, brand.id))[0]!;
  await h.engine.acceptPlan(OWNER, brand.id, plan.id);
  const pillar = briefs.find((b) => b.role === 'pillar')!;
  // Crash while storing the version (process dies mid-write).
  h.store.failNext.addVersion = 1;
  await h.engine.requestArticles(OWNER, brand.id, [pillar.id]);
  await h.engine.requestArticles(OWNER, brand.id, [pillar.id]); // double click: same job
  await h.engine.tick('worker-1');
  let jobs = (await h.engine.listJobs(OWNER, brand.id)).filter((j) => j.kind === 'write');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.state, 'queued', 'the failed attempt is retried, not lost');
  // A new process picks it up after the backoff.
  h.clock.advance(5 * 60_000);
  await h.makeEngine().tick('worker-2');
  jobs = (await h.engine.listJobs(OWNER, brand.id)).filter((j) => j.kind === 'write');
  assert.equal(jobs[0]!.state, 'done');
  const articles = await h.engine.listArticles(OWNER, brand.id);
  assert.equal(articles.length, 1);
  assert.equal((await h.engine.getArticle(OWNER, brand.id, articles[0]!.article.id)).versions.length, 1);

  // Crash after the begin boundary committed (operation + claim) but before the provider call.
  const destination = await connectGithub(h, brand);
  const b = await h.engine.getBrand(OWNER, brand.id);
  await h.engine.updateSettings(OWNER, brand.id, b.rowVersion, { autoPublish: true });
  const id = articles[0]!.article.id;
  await h.engine.schedule(OWNER, brand.id, id, (await h.store.getArticle(brand.id, id))!.rowVersion, { localDate: '2026-11-05', localTime: '09:00', destinationId: destination.id });
  h.clock.set('2026-11-05T09:00:10.000Z');
  h.store.failNext.updatePublication = 1;
  await assert.rejects(h.engine.dispatchDue(brand.id));
  assert.equal((await h.engine.getArticle(OWNER, brand.id, id)).publications[0]!.state, 'prepared', 'the authorised operation was recorded before any send');
  assert.equal(h.github.refPatches, 0);
  h.clock.advance(10 * 60_000);
  await h.makeEngine().tick('worker-3');
  const detail = await h.engine.getArticle(OWNER, brand.id, id);
  assert.equal(detail.publications.length, 1);
  assert.equal(detail.status, 'Published', detail.publications[0]!.detail);
  assert.equal(h.github.refPatches, 1);
});

test('A8/A11: a second brand uses the content-API type without code changes; failures stay inside their brand', async () => {
  const h = harness();
  const harbour = await readyBrand(h, 'Harbour Lettings', 'https://harbour.example', 'deposits');
  const bay = await readyBrand(h, 'Bay Property Club', 'https://bay.example', 'deposits');
  const bayArticles = (await planAndWrite(h, bay, 1)).articles;
  const destination = await h.engine.connectDestination(OWNER, bay.id, {
    type: 'content_api', label: 'Bay website', credential: 'x'.repeat(40),
    config: { endpoint: 'https://bay.example/api/blog/publish', publicBaseUrl: 'https://bay.example', blogPath: 'blog' },
  });
  assert.equal(destination.status, 'connected', destination.statusDetail);
  // Destinations, articles and settings are isolated per brand.
  assert.equal((await h.engine.listDestinations(OWNER, harbour.id)).length, 0);
  assert.ok((await h.engine.listDestinations(OWNER, bay.id)).every((d) => !('sealedCredential' in d)), 'credentials never leave the server');
  await assert.rejects(h.engine.schedule(OWNER, harbour.id, bayArticles[0]!.article.id, 1, { localDate: '2026-11-03', localTime: '09:00', destinationId: destination.id }), { status: 404 });
  const id = bayArticles[0]!.article.id;
  const b = await h.engine.getBrand(OWNER, bay.id);
  await h.engine.updateSettings(OWNER, bay.id, b.rowVersion, { autoPublish: true });
  await h.engine.schedule(OWNER, bay.id, id, (await h.store.getArticle(bay.id, id))!.rowVersion, { localDate: '2026-11-03', localTime: '09:00', destinationId: destination.id });
  // A wrong secret on another connection fails truthfully.
  const bad = await h.engine.connectDestination(OWNER, harbour.id, { type: 'content_api', label: 'Wrong', credential: 'y'.repeat(40), config: { endpoint: 'https://bay.example/api/blog/publish', publicBaseUrl: 'https://bay.example' } });
  assert.equal(bad.status, 'failed');
  h.clock.set('2026-11-03T09:00:30.000Z');
  await h.engine.tick('worker-1');
  const detail = await h.engine.getArticle(OWNER, bay.id, id);
  assert.equal(detail.status, 'Published', detail.publications[0]?.detail);
  assert.equal(h.site.posts, 1);
  assert.equal(detail.article.publishedUrl, `https://bay.example/blog/${detail.version!.body.slug}`);
});

test('A11: missing research, exhausted budget and unavailable generation block only the affected brand and stage', async () => {
  const h = harness();
  const brand = await readyBrand(h, 'Harbour Lettings', 'https://harbour.example', 'deposits');
  const noResearch = new SeoBlogEngine({ store: h.store, llm: h.llm, search: new UnconfiguredSearchProvider(), transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now });
  await assert.rejects(noResearch.requestPlan(OWNER, brand.id, { commandId: randomUUID() }), { code: 'not_ready' });
  const b = await h.engine.getBrand(OWNER, brand.id);
  await h.engine.updateSettings(OWNER, brand.id, b.rowVersion, { budgets: { modelTokensPerMonth: 10, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  await assert.rejects(h.engine.requestPlan(OWNER, brand.id, { commandId: randomUUID() }), { code: 'budget_exceeded' });
  // A plan job whose model fails is blocked/retried with an honest message; nothing is fabricated.
  const b2 = await h.engine.getBrand(OWNER, brand.id);
  await h.engine.updateSettings(OWNER, brand.id, b2.rowVersion, { budgets: BUDGETS });
  h.llm.failNext = 1;
  await h.engine.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await h.engine.tick('worker-1');
  const job = (await h.engine.listJobs(OWNER, brand.id)).find((j) => j.kind === 'plan')!;
  assert.equal(job.state, 'blocked');
  assert.match(job.error!, /writing model could not be reached/);
  assert.equal((await h.engine.listPlans(OWNER, brand.id)).length, 0);
  await h.engine.retryJob(OWNER, brand.id, job.id);
  await h.engine.tick('worker-1');
  assert.equal((await h.engine.listPlans(OWNER, brand.id)).length, 1);
});

test('A11: changing factual knowledge invalidates checks and holds publication; visual guidance does not', async () => {
  const h = harness();
  const { brand, id } = await scheduledArticle(h, { autoPublish: true, requiresApproval: false, approve: false });
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'visual_guidance', title: 'Moodboard', pastedText: 'Use calm blues.' });
  assert.notEqual((await h.engine.readiness(OWNER, brand.id)).profile, 'stale');
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'New prices', pastedText: 'The Compliance Plan now costs £59 per month.' });
  assert.equal((await h.engine.readiness(OWNER, brand.id)).profile, 'stale');
  h.clock.set('2026-11-03T09:00:30.000Z');
  await h.engine.tick('worker-1');
  const d = await h.engine.getArticle(OWNER, brand.id, id);
  assert.equal(d.article.hold?.reason, 'checks_failed');
  assert.ok(d.article.checks!.issues.some((i) => i.code === 'profile.stale'));
  assert.equal(h.github.refPatches, 0);
});

test('ongoing production tops up within the backlog ceiling and never duplicates drafts', async () => {
  const h = harness();
  const brand = await readyBrand(h, 'Harbour Lettings', 'https://harbour.example', 'deposits');
  const b = await h.engine.getBrand(OWNER, brand.id);
  await h.engine.updateSettings(OWNER, brand.id, b.rowVersion, { ongoingProduction: true, autoAcceptPlans: true, backlogCeiling: 2 });
  await h.engine.enqueueDailyForAll([brand.id]);
  await h.engine.enqueueDailyForAll([brand.id]);
  for (let i = 0; i < 4; i++) await h.engine.tick('worker-1');
  const articles = await h.engine.listArticles(OWNER, brand.id);
  assert.equal(articles.length, 2, 'drafting stops at the backlog ceiling');
  assert.equal((await h.engine.listPlans(OWNER, brand.id)).length, 1, 'one daily plan per day');
  assert.ok(articles.every((a) => !a.article.schedule), 'drafting never schedules or publishes by itself');
});

// ─── Defect fixes: reconciliation revalidation and the begin boundary ────────

async function unknownAbsent(row: { autoPublish: boolean; requiresApproval: boolean; approve: boolean }) {
  const h = harness();
  const { brand, id } = await scheduledArticle(h, row);
  h.clock.set('2026-11-03T09:00:30.000Z');
  // The site never applies it (first send and the same tick's reconciliation resend), but the worker cannot know.
  h.github.failNextRefBeforeApply = 2;
  await h.engine.dispatchDue(brand.id);
  const detail = await h.engine.getArticle(OWNER, brand.id, id);
  assert.equal(detail.publications[0]!.state, 'outcome_unknown');
  assert.equal(h.github.refPatches, 0);
  return { h, brand, id, publicationId: detail.publications[0]!.id };
}

test('defect 1: a confirmed-absent operation is not re-sent after Pause all', async () => {
  const { h, brand, id, publicationId } = await unknownAbsent({ autoPublish: true, requiresApproval: false, approve: false });
  const b = await h.engine.getBrand(OWNER, brand.id);
  await h.engine.updateSettings(OWNER, brand.id, b.rowVersion, { pauseAll: true });
  h.clock.advance(60_000);
  await h.engine.reconcile(brand.id);
  const d = await h.engine.getArticle(OWNER, brand.id, id);
  assert.equal(h.github.refPatches, 0, 'nothing was re-sent');
  assert.equal(d.publications.length, 1);
  assert.equal(d.publications[0]!.id, publicationId, 'operation identity preserved');
  assert.equal(d.publications[0]!.state, 'cancelled');
  assert.ok(d.publications[0]!.events!.some((e) => e.state === 'outcome_unknown'), 'unknown-outcome history preserved');
  assert.equal(d.article.hold?.reason, 'paused');
  assert.equal(d.article.delivery, 'none');
});

test('defect 1: a confirmed-absent operation is not re-sent after the article was edited', async () => {
  const { h, brand, id } = await unknownAbsent({ autoPublish: true, requiresApproval: false, approve: false });
  const before = await h.engine.getArticle(OWNER, brand.id, id);
  // The unknown-outcome hold blocks owner edits to scheduling, but content edits create a new version.
  await h.engine.editArticle(OWNER, brand.id, id, before.version!.id, { title: 'Tenancy deposit protection: revised landlord guide' });
  h.clock.advance(60_000);
  await h.engine.reconcile(brand.id);
  const d = await h.engine.getArticle(OWNER, brand.id, id);
  assert.equal(h.github.refPatches, 0);
  assert.equal(d.publications[0]!.state, 'cancelled');
  assert.match(d.publications[0]!.detail, /superseded/);
});

test('defect 1: a confirmed-absent operation whose approval no longer matches is held, not re-sent', async () => {
  const { h, brand, id } = await unknownAbsent({ autoPublish: false, requiresApproval: false, approve: true });
  const b = await h.engine.getBrand(OWNER, brand.id);
  await h.engine.updateSettings(OWNER, brand.id, b.rowVersion, { autoPublish: false }); // still requires approval
  const a = (await h.store.getArticle(brand.id, id))!;
  await h.store.updateArticle({ ...a, approval: null }); // approval withdrawn while the outcome was unknown
  h.clock.advance(60_000);
  await h.engine.reconcile(brand.id);
  const d = await h.engine.getArticle(OWNER, brand.id, id);
  assert.equal(h.github.refPatches, 0);
  assert.equal(d.article.hold?.reason, 'missing_approval');
});

test('defect 1: a still-authorised absent operation is re-sent once with the same identity and history', async () => {
  const { h, brand, id, publicationId } = await unknownAbsent({ autoPublish: true, requiresApproval: false, approve: false });
  h.clock.advance(60_000);
  await Promise.all([h.engine.reconcile(brand.id), h.makeEngine().reconcile(brand.id)]);
  const d = await h.engine.getArticle(OWNER, brand.id, id);
  assert.equal(h.github.refPatches, 1, 'exactly one re-send');
  assert.equal(d.publications.length, 1);
  assert.equal(d.publications[0]!.id, publicationId);
  assert.equal(d.publications[0]!.state, 'published');
  const states = d.publications[0]!.events!.map((e) => e.state);
  assert.deepEqual(states.filter((s) => s === 'outcome_unknown').length >= 1, true);
  assert.ok(states.indexOf('outcome_unknown') < states.lastIndexOf('prepared'), 'history shows the unknown outcome before re-authorisation');
});

test('defect 1: status verification of an applied operation continues while paused', async () => {
  const h = harness();
  const { brand, id } = await scheduledArticle(h, { autoPublish: true, requiresApproval: false, approve: false });
  h.clock.set('2026-11-03T09:00:30.000Z');
  h.github.dropNextRefResponse = true; // applied, response lost
  await h.engine.dispatchDue(brand.id);
  const b = await h.engine.getBrand(OWNER, brand.id);
  await h.engine.updateSettings(OWNER, brand.id, b.rowVersion, { pauseAll: true });
  h.clock.advance(60_000);
  await h.engine.reconcile(brand.id);
  const d = await h.engine.getArticle(OWNER, brand.id, id);
  assert.equal(d.status, 'Published', 'what is already on the site is recognised, not re-sent');
  assert.equal(h.github.refPatches, 1);
});

test('defect 2: begin boundary — a pause committed before begin prevents dispatch; duplicates begin once', async () => {
  const h = harness();
  const { brand, id } = await scheduledArticle(h, { autoPublish: true, requiresApproval: false, approve: false });
  h.clock.set('2026-11-03T09:00:30.000Z');
  // Duplicate workers racing the same due article.
  const engines = [h.engine, h.makeEngine(), h.makeEngine()];
  await Promise.all(engines.map((e) => e.dispatchDue(brand.id)));
  assert.equal((await h.store.listPublications(brand.id)).length, 1);
  assert.equal(h.github.refPatches, 1);
  // A second brand article paused before the boundary is held without an operation.
  const h2 = harness();
  const s2 = await scheduledArticle(h2, { autoPublish: true, requiresApproval: false, approve: false });
  const b2 = await h2.engine.getBrand(OWNER, s2.brand.id);
  await h2.engine.updateSettings(OWNER, s2.brand.id, b2.rowVersion, { pauseAll: true });
  h2.clock.set('2026-11-03T09:00:30.000Z');
  await h2.engine.dispatchDue(s2.brand.id);
  assert.equal((await h2.store.listPublications(s2.brand.id)).length, 0);
  assert.equal((await h2.engine.getArticle(OWNER, s2.brand.id, s2.id)).article.hold?.reason, 'paused');
  void id;
});
