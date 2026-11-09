import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { pageHead } from '../src/portal/ui.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';

function luminance(hex: string): number {
  const rgb = hex.replace('#', '').match(/../g)!.map(part => parseInt(part, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * rgb[0]! + .7152 * rgb[1]! + .0722 * rgb[2]!;
}
test('HQ secondary text has at least 4.5:1 contrast on each theme surface', () => {
  const dark = PROPERTY_PREDATOR_GROWTH_PROFILE.theme;
  for (const [inks, surfaces] of [
    [[dark.ink, dark.muted, dark.faint], [dark.canvas, dark.panel, dark.panelSubtle, dark.panelStrong]],
    [['#14201f', '#536765'], ['#ffffff', '#f4f7f6', '#f7faf9', '#e9f0ee']],
  ]) {
    for (const ink of inks!) for (const surface of surfaces!) {
      const values = [luminance(ink), luminance(surface)].sort((a, b) => a - b);
      assert.ok((values[1]! + .05) / (values[0]! + .05) >= 4.5, `${ink} on ${surface}`);
    }
  }
});
test('HQ common reading text and fields use 16px with legible placeholders', () => {
  const head = pageHead('Readability', PROPERTY_PREDATOR_GROWTH_PROFILE);
  assert.match(head, /:is\(p,label,input,select,textarea,button,summary\)\{font-size:1rem/);
  assert.match(head, /textarea::placeholder\{color:var\(--muted\);opacity:1\}/);
  assert.match(head, /--sans:"Segoe UI",Arial/);
  assert.doesNotMatch(head, /--faint:#667b78/);
});
test('calendar has no hard-coded dark surface or sub-14px font declarations', () => {
  const source = readFileSync(new URL('../src/portal/content-calendar-view.ts', import.meta.url), 'utf8');
  const css = source.split('const CONTENT_CALENDAR_STYLE = `')[1]!.split('`;')[0]!;
  assert.doesNotMatch(css, /background:#[0-9a-f]/);
  assert.doesNotMatch(css, /font(?:-size)?:[^;{}]*\b(?:[0-9]|1[0-3])px/);
  assert.match(css, /\.ccal-live-scheduler\{[^}]*background:var\(--cal-panel\)/);
  assert.match(css, /\.ccal p,[^}]*font-size:1rem/);
});
