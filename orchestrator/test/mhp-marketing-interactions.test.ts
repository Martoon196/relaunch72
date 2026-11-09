import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { MHP_CRM_CLIENT_SOURCE } from '../src/mhp/crm-client.js';

test('existing card client handles marketing click, keyboard and drag through the saved stage form', () => {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const navigations: string[] = [], submissions: string[] = [];
  class Element {
    readonly classes = new Set<string>();
    readonly classList = { add: (value: string) => this.classes.add(value), remove: (value: string) => this.classes.delete(value) };
    dataset: Record<string, string> = {};
    draggable = false;
    parent: Element | null = null;
    constructor(readonly tag: string, className = '') { if (className) this.classes.add(className); }
    matches(selector: string): boolean {
      return selector.split(',').some(item => item.startsWith('.') ? this.classes.has(item.slice(1)) : this.tag === item);
    }
    closest(selector: string): Element | null {
      if (selector === '.crm-stage-column[data-stage-id]' && this.classes.has('crm-stage-column') && this.dataset.stageId) return this;
      return this.matches(selector) ? this : this.parent?.closest(selector) ?? null;
    }
    querySelector(selector: string): unknown {
      if (this === card && selector === '.crm-move-form') return form;
      if (this === card && selector === '.crm-move-field select') return select;
      return null;
    }
  }
  const source = new Element('section', 'crm-stage-column'); source.dataset.stageId = 'source-stage';
  const target = new Element('section', 'crm-stage-column'); target.dataset.stageId = 'target-stage';
  const card = new Element('article', 'mhp-marketing-card'); card.parent = source; card.draggable = true;
  card.dataset = { opportunityId: 'saved-opportunity', contactHref: '/portal/crm/contacts/saved-contact' };
  const link = new Element('a'); link.parent = card;
  const select = { options: [{ value: 'target-stage' }], value: '' };
  const button = {};
  const form = { querySelector: (selector: string) => selector.startsWith('select') ? select : button,
    requestSubmit: (actual: unknown) => { assert.equal(actual, button); submissions.push(select.value); } };
  const board = { addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => handlers.set(name, handler),
    querySelectorAll: () => [source, target].filter(stage => stage.classes.has('mhp-drop-target')) };
  runInNewContext(MHP_CRM_CLIENT_SOURCE, { Element, document: { querySelector: () => board }, location: { assign: (url: string) => navigations.push(url) } });
  const event = (target: Element, extra: Record<string, unknown> = {}) => ({ target, preventDefault() {}, ...extra });
  handlers.get('click')!(event(card));
  handlers.get('click')!(event(link));
  handlers.get('keydown')!(event(card, { key: 'Enter' }));
  handlers.get('keydown')!(event(card, { key: ' ' }));
  assert.deepEqual(navigations, Array(3).fill(card.dataset.contactHref));
  let value = '';
  const transfer = { setData: (_type: string, data: string) => { value = data; }, getData: () => value, effectAllowed: '', dropEffect: '' };
  handlers.get('dragstart')!(event(card, { dataTransfer: transfer }));
  assert.equal(value, card.dataset.opportunityId);
  handlers.get('dragover')!(event(target, { dataTransfer: transfer }));
  assert.equal(target.classes.has('mhp-drop-target'), true);
  handlers.get('drop')!(event(target, { dataTransfer: transfer }));
  assert.deepEqual(submissions, ['target-stage']);
  assert.equal(card.classes.has('mhp-dragging'), false);
  assert.equal(target.classes.has('mhp-drop-target'), false);
});
