/** Fixed presentation links only. Callers pass existing access facts; routes enforce authority. */
export function mhpMemberNavigationLinks(input: { owner?: boolean; desk?: boolean; crm?: boolean } = {}): string {
  return '<a href="/app/learn">Training centre</a>'
    + (input.desk !== false ? '<a href="/app/desk">Deal Desk</a>' : '')
    + (input.crm !== false ? '<a href="/portal/investors">Investor CRM</a>' : '')
    + '<a href="/app/account">Account</a>'
    + (input.owner === true ? '<a href="/hq">HQ</a>' : '');
}
