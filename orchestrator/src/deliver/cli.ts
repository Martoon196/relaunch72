/**
 * Delivery CLI — package an APPROVED pack for sending (LS-19 → delivery).
 *
 *   npm run deliver -- --run runs/<id> [--to a@b.com] [--first-name Sam]
 *
 * Refuses any run that hasn't been approved at the sign-off gate. Produces, in
 * the run's delivery/ folder: the customer email (text + a .eml you can open
 * and send from any client), and a zip of the branded PDFs. No auto-send — the
 * founder chooses how these go out.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Signoff } from '../types.js';
import { renderRun } from '../docs/render.js';
import { buildDeliveryEmail, buildEml, attachmentList } from './deliver.js';

interface Args { run?: string; to?: string; firstName?: string }
function parse(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--run') a.run = argv[++i];
    else if (t === '--to') a.to = argv[++i];
    else if (t === '--first-name') a.firstName = argv[++i];
    else throw new Error(`Unknown argument: ${t}`);
  }
  return a;
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  if (!args.run) throw new Error('Provide --run <run dir>');
  const runDir = path.resolve(args.run);

  const signoffPath = path.join(runDir, 'signoff.json');
  if (!fs.existsSync(signoffPath)) {
    console.error('Not signed off yet — run `npm run signoff -- --run <dir> --approve` first. Nothing ships un-approved.');
    return 2;
  }
  const signoff = JSON.parse(fs.readFileSync(signoffPath, 'utf8')) as Signoff;
  if (signoff.decision !== 'approved') {
    console.error(`This pack was ${signoff.decision}, not approved — delivery is blocked until it's approved.`);
    return 2;
  }

  const bundle = JSON.parse(fs.readFileSync(path.join(runDir, 'bundle.json'), 'utf8')) as {
    business: string; compliance_line: string; deliverables: Array<{ stage: string }>;
  };
  const stages = bundle.deliverables.map((d) => d.stage);

  // Make sure the branded PDFs exist (idempotent — re-renders from passed stages).
  const rendered = await renderRun(runDir, { pdf: true });

  const deliveryDir = path.join(runDir, 'delivery');
  fs.mkdirSync(deliveryDir, { recursive: true });

  const email = buildDeliveryEmail({
    business: bundle.business,
    stages,
    complianceLine: bundle.compliance_line,
    firstName: args.firstName,
  });
  fs.writeFileSync(path.join(deliveryDir, 'email.txt'), `Subject: ${email.subject}\n\n${email.body}\n`, 'utf8');
  const eml = buildEml(email, { to: args.to, date: signoff.at });
  fs.writeFileSync(path.join(deliveryDir, 'delivery.eml'), eml, 'utf8');

  // Zip the branded PDFs for attachment (best-effort — falls back to a manifest).
  const slug = bundle.business.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'relaunch72';
  const zipName = `${slug}-relaunch72-pack.zip`;
  const pdfs = rendered.pdf.map((f) => path.join(rendered.docsDir, f));
  let packaged = '';
  try {
    execFileSync('zip', ['-j', path.join(deliveryDir, zipName), ...pdfs], { stdio: 'ignore' });
    packaged = zipName;
  } catch {
    fs.writeFileSync(path.join(deliveryDir, 'attachments.txt'), attachmentList(rendered.docsDir, stages).join('\n') + '\n', 'utf8');
    packaged = 'attachments.txt (zip unavailable — attach the listed PDFs)';
  }

  console.log(`Delivery pack for ${bundle.business} → ${path.relative(process.cwd(), deliveryDir)}`);
  console.log(`  • email.txt / delivery.eml   (open the .eml in any client — Gmail included — and send)`);
  console.log(`  • ${packaged}   (${pdfs.length} branded PDFs)`);
  console.log(args.to ? `  Addressed to ${args.to}.` : `  No recipient set — the .eml has a {{customer_email}} placeholder to fill.`);
  console.log('  Nothing was sent. You choose how it goes out.');
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(`Error: ${(e as Error).message}`); process.exit(1); });
