import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmazonTrackingReport, AmazonReportError } from '../src/creative-studio/amazon-tracking-report.js';

test('Amazon UK tab-delimited Tracking ID Summary differentiates real numbers from suppressed cells',()=>{
  const report='\uFEFFTracking ID\tClicks\tOrdered Items\tShipped Items\tEarnings\n'
    +'survival-21\t100\t3\t2\t£17.25\n'
    +'property-21\t-\t-\t-\t-\n'
    +'Others\t20\t3\t2\t£5.75\n'
    +'Total\t120\t6\t4\t£23.00\n';
  const result=parseAmazonTrackingReport(report);
  assert.equal(result.source,'user_uploaded_amazon_tracking_id_summary');
  assert.equal(result.rows.length,3); // total is excluded to avoid double-count
  assert.equal(result.knownEarningsMinor,2300);
  assert.equal(result.unallocatedEarningsMinor,575);
  assert.equal(result.unknownEarningsRows,1);
  assert.equal(result.clicksUnknownRows,1);
  assert.equal(result.clicksKnown,120);
  assert.equal(result.rows[1]?.earningsMinor,null,'Hidden is unknown, not zero');
  assert.equal(result.rows[2]?.isOther,true);
});
test('accepts legitimate quoted CSV with separators and negative refunds',()=>{
  const r=parseAmazonTrackingReport('Tracking ID,Product Link Clicks,Earnings\n"my,shop",12,"£1,234.05"\nothers,9,(£5.25)\n');
  assert.equal(r.rows[0]?.trackingId,'my,shop');
  assert.equal(r.knownEarningsMinor,122880);
  assert.equal(r.unallocatedEarningsMinor,-525);
});
test('rejects unsupported report type, foreign currency and malformed monetary figures',()=>{
  assert.throws(()=>parseAmazonTrackingReport('Order ID,ASIN,Earnings\n111,222,£5.00\n'),/Tracking ID Summary/);
  assert.throws(()=>parseAmazonTrackingReport('Tracking ID,Earnings\nabc,$5.00\n'),/Foreign currency/);
  assert.throws(()=>parseAmazonTrackingReport('Tracking ID,Earnings\nabc,£5.001\n'),/Invalid GBP/);
  assert.throws(()=>parseAmazonTrackingReport('Tracking ID,Earnings\nabc,garbage\n'),AmazonReportError);
});
test('suppressed-only report never fabricates income, commissions or click-to-sale attribution',()=>{
  const r=parseAmazonTrackingReport('Tracking ID\tEarnings\nshop-21\t—\nOthers\t-\n');
  assert.equal(r.knownEarningsMinor,0);
  assert.equal(r.unknownEarningsRows,2);
  assert.equal(r.rows[0]?.earningsMinor,null);
  assert.equal('orders' in r,false);
  assert.match(r.warning,/Unknown cells are not zero/);
});
test('report sizes are bounded and no HTML/markup tracking IDs accepted',()=>{
  assert.throws(()=>parseAmazonTrackingReport('Tracking ID,Earnings\n<script>,£5.00\n'),/Invalid tracking ID/);
  assert.throws(()=>parseAmazonTrackingReport('x'.repeat(2_100_000)),/maximum 2 MB/);
});
