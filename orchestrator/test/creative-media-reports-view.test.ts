import test from 'node:test';
import assert from 'node:assert/strict';
import { creativeMediaReportsPage } from '../src/portal/creative-media-reports-view.js';
import type { SavedReportSummary } from '../src/creative-studio/amazon-report-pg-store.js';
import type { Shell } from '../src/portal/seo-blog-view.js';

test('Amazon imported report screen distinguishes merchant earnings, unknown and Others',()=>{
  const shell={
    csrf:'secure-form-test',brand:{id:'33f3e8cd-c699-48fd-bc8b-3d0b43a0b387',
      name:'Shop',slug:'shop'},brands:[],tab:'creative',
  } as unknown as Shell;
  const record:SavedReportSummary={
    id:'d4fa3a7f-6229-45f9-b8a4-fd98d6792aa3',
    source:'user_uploaded_amazon_tracking_id_summary',
    reportStart:'2026-11-01',reportEnd:'2026-11-15',currency:'GBP',
    createdAt:'2026-11-16T00:00:00Z',
    summary:{
      source:'user_uploaded_amazon_tracking_id_summary',currency:'GBP',
      knownEarningsMinor:1625,unallocatedEarningsMinor:375,
      unknownEarningsRows:1,clicksKnown:55,clicksUnknownRows:1,
      hasUnallocatedEarnings:true,warning:'Unknown is not zero',
    },
  };
  const html=creativeMediaReportsPage(shell,[record],'unique-id');
  assert.match(html,/Amazon Associates report/u);
  assert.match(html,/£16\.25/u);
  assert.match(html,/£3\.75/u);
  assert.match(html,/rows unknown/u);
  assert.match(html,/secure-form-test/u);
  assert.match(html,/enctype="multipart\/form-data"/u);
  assert.match(html,/No customer records/u);
  assert.doesNotMatch(html,/Verified by Amazon API/u);
});
