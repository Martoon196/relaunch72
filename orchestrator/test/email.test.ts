import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryMessage, EmailError, type PostmarkLike, type PostmarkMessage } from '../src/email/postmark.js';
import { buildDeliveryEmail } from '../src/deliver/deliver.js';

const email = buildDeliveryEmail({
  business: 'Acme Joinery',
  stages: ['S1', 'S9'],
  complianceLine: 'This document is marketing material, not a guarantee of results.',
  firstName: 'Sam',
});

test('deliveryMessage maps a delivery email to a Postmark transactional message', () => {
  const msg = deliveryMessage(email, { to: 'sam@acme.com' });
  assert.equal(msg.to, 'sam@acme.com');
  assert.equal(msg.subject, email.subject);
  assert.equal(msg.textBody, email.body);
  assert.equal(msg.from, 'Relaunch72 <hello@relaunch72.com>'); // default sender
  assert.equal(msg.messageStream, 'outbound');
});

test('deliveryMessage honours from / replyTo / attachments', () => {
  const msg = deliveryMessage(email, {
    to: 'a@b.com', from: 'Relaunch72 <hi@relaunch72.com>', replyTo: 'help@relaunch72.com',
    attachments: [{ name: 'index.pdf', contentBase64: 'JVBERi0=', contentType: 'application/pdf' }],
  });
  assert.equal(msg.from, 'Relaunch72 <hi@relaunch72.com>');
  assert.equal(msg.replyTo, 'help@relaunch72.com');
  assert.equal(msg.attachments?.length, 1);
  assert.equal(msg.attachments?.[0]?.name, 'index.pdf');
});

test('deliveryMessage refuses an invalid or empty recipient (no accidental sends)', () => {
  assert.throws(() => deliveryMessage(email, { to: 'not-an-email' }), EmailError);
  assert.throws(() => deliveryMessage(email, { to: '' }), EmailError);
  assert.throws(() => deliveryMessage(email, { to: 'a@b' }), EmailError);
});

test('a PostmarkLike client receives exactly the built message', async () => {
  const sent: PostmarkMessage[] = [];
  const fake: PostmarkLike = {
    send: async (m) => { sent.push(m); return { messageId: 'mid_1', to: m.to, errorCode: 0, message: 'OK' }; },
  };
  const r = await fake.send(deliveryMessage(email, { to: 'sam@acme.com' }));
  assert.equal(r.messageId, 'mid_1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.subject, email.subject);
  assert.equal(sent[0]!.messageStream, 'outbound');
});
