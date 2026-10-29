type MhpCrmSection = 'contacts' | 'pipeline' | 'tasks';

/** Keep the shared CRM actions and records, with a readable MHP working surface. */
export function renderMhpCrmBody(body: string, active: MhpCrmSection): string {
  const links: readonly [string, string, MhpCrmSection | 'conversations'][] = [
    ['Investors', '/portal/crm/contacts', 'contacts'],
    ['Pipeline', '/portal/crm/opportunities', 'pipeline'],
    ['Follow-ups', '/portal/crm/tasks', 'tasks'],
    ['Conversations', '/portal/investors/email', 'conversations'],
  ];
  return `<style data-mhp-crm>
    .mhp-crm{color:#142019;font:400 16px/1.55 system-ui,sans-serif}
    .mhp-crm *{box-sizing:border-box}
    .mhp-crm-nav{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 20px}
    .mhp-crm-nav a{display:inline-flex;align-items:center;min-height:46px;padding:10px 17px;border:1px solid #b9c5b8;border-radius:10px;background:#fff;color:#142019;font:700 16px/1.3 system-ui,sans-serif;text-decoration:none}
    .mhp-crm-nav a:hover{background:#fff2dc}.mhp-crm-nav a[aria-current="page"]{background:#E8A33D;border-color:#E8A33D}
    .mhp-crm a:focus-visible{outline:3px solid #83510c;outline-offset:2px}
    .mhp-crm .crm-subnav{display:none}
    .mhp-crm .crm-page-heading h1{font-size:clamp(30px,3vw,40px)}
    .mhp-crm .crm-page-heading p,.mhp-crm .crm-page-heading .crm-heading-meta{font-size:15px;line-height:1.5}
    .mhp-crm .crm-page-heading .eyebrow{font-size:13px}
    .mhp-crm .crm-panel-head h2,.mhp-crm .crm-stage-head h2{font-size:20px}
    .mhp-crm .crm-panel-head p,.mhp-crm .crm-board-help,.mhp-crm .crm-stage-empty,.mhp-crm .crm-card-note,.mhp-crm .crm-timeline-copy p,.mhp-crm .crm-timeline-copy small{font-size:14px;line-height:1.5}
    .mhp-crm .crm-board{grid-auto-columns:minmax(330px,1fr)}
    .mhp-crm .crm-stage-column{padding:14px}.mhp-crm .crm-stage-head{padding-bottom:14px}
    .mhp-crm .crm-stage-total,.mhp-crm .crm-meta-item span,.mhp-crm .crm-move-field label{font-size:13px}
    .mhp-crm .crm-opportunity{padding:16px}.mhp-crm .crm-opportunity h3,.mhp-crm .crm-task h3{font-size:18px}
    .mhp-crm .crm-opportunity-contact,.mhp-crm .crm-meta-item strong,.mhp-crm .crm-task-context,.mhp-crm .crm-task-meta,.mhp-crm .crm-task-status,.mhp-crm .crm-due-state{font-size:15px;line-height:1.45}
    .mhp-crm .crm-move-field select,.mhp-crm .crm-move-form .button{font-size:15px;min-height:44px}
    .mhp-crm .crm-table,.mhp-crm .crm-field input,.mhp-crm .crm-field select,.mhp-crm .crm-filterlinks a,.mhp-crm .crm-notice strong,.mhp-crm .crm-unavailable{font-size:16px}
    .mhp-crm .crm-table th,.mhp-crm .crm-table td,.mhp-crm .crm-contact-company,.mhp-crm .crm-secondary,.mhp-crm .crm-reach,.mhp-crm .crm-number,.mhp-crm .crm-date,.mhp-crm .crm-lifecycle,.mhp-crm .crm-field label,.mhp-crm .crm-field-hint,.mhp-crm .crm-effect-note,.mhp-crm .crm-empty p,.mhp-crm .crm-pagination,.mhp-crm .crm-complete-form p{font-size:14px;line-height:1.5}
    .mhp-crm .crm-task{padding:16px}.mhp-crm .crm-notice p,.mhp-crm .crm-empty strong,.mhp-crm .crm-legend{font-size:16px}
    @media(max-width:640px){.mhp-crm .crm-board{grid-auto-columns:minmax(285px,88vw)}.mhp-crm .crm-table td::before{font-size:13px}.mhp-crm-nav a{flex:1 1 140px;justify-content:center}}
  </style><div class="mhp-crm"><nav class="mhp-crm-nav" aria-label="Your Desk CRM">${links.map(([label, href, section]) => `<a href="${href}"${active === section ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>${body}</div>`;
}
