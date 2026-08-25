import assert from 'node:assert/strict';
import test from 'node:test';
import { JOURNEY_BOARD_CLIENT_SOURCE } from '../src/portal/journey-board-client.js';

type Listener = (event: FakeEvent) => void;

interface FakeEvent {
  readonly type: string;
  target: FakeElement;
  button: number;
  isPrimary: boolean;
  pointerId: number;
  clientX: number;
  clientY: number;
  key: string;
  shiftKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function event(type: string, target: FakeElement, values: Partial<FakeEvent> = {}): FakeEvent {
  return {
    type,
    target,
    button: 0,
    isPrimary: true,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    key: '',
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    ...values,
  };
}

class FakeElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly classes = new Set<string>();
  readonly classList = { add: (...names: string[]) => names.forEach((name) => this.classes.add(name)) };
  parentElement: FakeElement | null = null;
  textContent = '';
  hidden = false;
  options: Array<{ value: string }> = [];
  value = '';
  scrollLeft = 0;
  submitCount = 0;
  focused = false;
  private capturedPointer: number | null = null;

  constructor(tagName: string, attributes: Record<string, string> = {}) {
    this.tagName = tagName.toLowerCase();
    for (const [name, value] of Object.entries(attributes)) this.setAttribute(name, value);
    for (const name of (attributes.class ?? '').split(/\s+/u).filter(Boolean)) this.classes.add(name);
  }

  append(...children: FakeElement[]): this {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(input: FakeEvent): void {
    for (const listener of this.listeners.get(input.type) ?? []) listener(input);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  contains(candidate: FakeElement | null): boolean {
    for (let current = candidate; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  private matchesSimple(selector: string): boolean {
    const trimmed = selector.trim();
    if (!trimmed) return false;
    const tag = /^[a-z]+/iu.exec(trimmed)?.[0]?.toLowerCase();
    if (tag && this.tagName !== tag) return false;
    for (const className of [...trimmed.matchAll(/\.([a-z0-9_-]+)/giu)].map((match) => match[1]!)) {
      if (!this.classes.has(className)) return false;
    }
    for (const match of trimmed.matchAll(/\[([a-z0-9_-]+)(?:="([^"]*)")?\]/giu)) {
      const [, name, expected] = match;
      if (!this.hasAttribute(name!)) return false;
      if (expected !== undefined && this.getAttribute(name!) !== expected) return false;
    }
    return Boolean(tag || trimmed.includes('.') || trimmed.includes('['));
  }

  closest(selector: string): FakeElement | null {
    const alternatives = selector.split(',').map((part) => part.trim());
    for (let current: FakeElement | null = this; current; current = current.parentElement) {
      if (alternatives.some((part) => current!.matchesSimple(part))) return current;
    }
    return null;
  }

  private descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === '.jb-lane-head h2') {
      return this.descendants().find((candidate) => candidate.tagName === 'h2') ?? null;
    }
    return this.descendants().find((candidate) => candidate.matchesSimple(selector)) ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((candidate) => candidate.matchesSimple(selector));
  }

  focus(): void {
    this.focused = true;
  }

  requestSubmit(): void {
    this.submitCount += 1;
  }

  setPointerCapture(pointerId: number): void {
    this.capturedPointer = pointerId;
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.capturedPointer === pointerId;
  }

  releasePointerCapture(pointerId: number): void {
    if (this.capturedPointer === pointerId) this.capturedPointer = null;
  }

  getBoundingClientRect(): { left: number; right: number; width: number } {
    return { left: 0, right: 800, width: 800 };
  }

  scrollBy(options: { left: number }): void {
    this.scrollLeft += options.left;
  }
}

class FakeDocument {
  readonly listeners = new Map<string, Listener[]>();
  readonly documentElement = new FakeElement('html');
  readonly body = new FakeElement('body');
  activeElement: FakeElement | null = null;
  pointElement: FakeElement | null = null;

  constructor(readonly root: FakeElement) {}

  querySelector(selector: string): FakeElement | null {
    return selector === '[data-journey-board]' ? this.root : null;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(input: FakeEvent): void {
    for (const listener of this.listeners.get(input.type) ?? []) listener(input);
  }

  elementFromPoint(): FakeElement | null {
    return this.pointElement;
  }
}

interface Harness {
  readonly root: FakeElement;
  readonly document: FakeDocument;
  readonly window: { matchMedia(): { matches: boolean }; setTimeout(callback: () => void): number; addEventListener(type: string, listener: Listener): void; location: { href: string; origin: string } };
  readonly card: FakeElement;
  readonly surface: FakeElement;
  readonly link: FakeElement;
  readonly handle: FakeElement;
  readonly form: FakeElement;
  readonly select: FakeElement;
  readonly lanes: readonly FakeElement[];
}

function harness(narrow: boolean): Harness {
  const root = new FakeElement('article', { 'data-journey-board': '' });
  const live = new FakeElement('div', { 'data-board-live': '' });
  const board = new FakeElement('div', { class: 'jb-board' });
  const lane = (id: string, label: string): FakeElement => {
    const result = new FakeElement('section', { 'data-journey-lane': '', 'data-lane-id': id });
    const head = new FakeElement('header', { class: 'jb-lane-head' });
    const heading = new FakeElement('h2');
    heading.textContent = label;
    head.append(heading);
    result.append(head);
    return result;
  };
  const lanes = [lane('new', 'New signal'), lane('qualified', 'Qualified'), lane('proposal', 'Proposal')];
  const card = new FakeElement('article', {
    'data-journey-card': '',
    'data-workflow-movable': 'true',
    'data-card-id': 'card-1',
  });
  const surface = new FakeElement('div', { class: 'jb-facts' });
  const person = new FakeElement('a', { class: 'jb-person' });
  person.textContent = 'Amelia Hart';
  const link = new FakeElement('a', { href: '/portal/crm/contacts/1' });
  const form = new FakeElement('form', { 'data-workflow-move-form': '' });
  const select = new FakeElement('select', { 'data-lane-select': '' });
  select.options = [{ value: 'qualified' }, { value: 'proposal' }];
  const handle = new FakeElement('button', { 'data-drag-handle': '', 'aria-pressed': 'false' });
  form.append(handle, select);
  card.append(person, link, surface, form);
  lanes[0]!.append(card);
  board.append(...lanes);
  root.append(live, board);
  const document = new FakeDocument(root);
  const windowListeners = new Map<string, Listener[]>();
  const window = {
    matchMedia: () => ({ matches: narrow }),
    setTimeout: (callback: () => void) => { callback(); return 1; },
    addEventListener: (type: string, listener: Listener) => {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    location: { href: 'http://127.0.0.1/portal/journeys/board', origin: 'http://127.0.0.1' },
  };
  const run = new Function('document', 'window', 'AbortController', 'DOMParser', JOURNEY_BOARD_CLIENT_SOURCE);
  run(document, window, AbortController, class {});
  return { root, document, window, card, surface, link, handle, form, select, lanes };
}

test('narrow card swipe chooses the next permitted lane and submits the protected fallback form', () => {
  const app = harness(true);
  app.root.dispatch(event('pointerdown', app.surface, { clientX: 20, clientY: 100 }));
  app.document.dispatch(event('pointermove', app.surface, { clientX: 80, clientY: 104 }));
  assert.equal(app.card.getAttribute('data-pointer-target-label'), 'Qualified');
  app.document.dispatch(event('pointerup', app.surface, { clientX: 80, clientY: 104 }));
  assert.equal(app.select.value, 'qualified');
  assert.equal(app.form.submitCount, 1);
});

test('narrow card swipe ignores interactive descendants and yields to vertical scrolling', () => {
  const interactive = harness(true);
  interactive.root.dispatch(event('pointerdown', interactive.link, { clientX: 20, clientY: 100 }));
  interactive.document.dispatch(event('pointermove', interactive.link, { clientX: 90, clientY: 102 }));
  interactive.document.dispatch(event('pointerup', interactive.link, { clientX: 90, clientY: 102 }));
  assert.equal(interactive.form.submitCount, 0);

  const vertical = harness(true);
  vertical.root.dispatch(event('pointerdown', vertical.surface, { clientX: 20, clientY: 100 }));
  vertical.document.dispatch(event('pointermove', vertical.surface, { clientX: 23, clientY: 125 }));
  vertical.document.dispatch(event('pointerup', vertical.surface, { clientX: 23, clientY: 125 }));
  assert.equal(vertical.form.submitCount, 0);
  assert.equal(vertical.card.hasAttribute('data-dragging'), false);
});

test('desktop handle pointer drop resolves the lane under the mouse and submits once', () => {
  const app = harness(false);
  app.document.pointElement = app.lanes[2]!;
  app.handle.dispatch(event('pointerdown', app.handle, { clientX: 20, clientY: 100 }));
  app.document.dispatch(event('pointermove', app.handle, { clientX: 200, clientY: 120 }));
  app.document.dispatch(event('pointerup', app.handle, { clientX: 200, clientY: 120 }));
  assert.equal(app.select.value, 'proposal');
  assert.equal(app.form.submitCount, 1);
});
