import { sealKeyFromEnvironment, sealMhpWhatsAppBinding } from './mhp-whatsapp-seal.js';

// Usage (token on stdin, never argv):
//   npm run --workspace orchestrator mhp:whatsapp:seal -- --app-id N --waba-id N --phone-number-id N < token.txt
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i] ?? '', process.argv[i + 1] ?? '');
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
try {
  const { key, version } = sealKeyFromEnvironment(process.env);
  const envelope = sealMhpWhatsAppBinding({ appId: args.get('--app-id') ?? '', wabaId: args.get('--waba-id') ?? '',
    phoneNumberId: args.get('--phone-number-id') ?? '', accessToken: Buffer.concat(chunks).toString('utf8').trim(), encryptionKey: key, keyVersion: version });
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
} catch (error) {
  process.stderr.write(`Seal refused: ${error instanceof Error ? error.message : 'invalid input'}\n`);
  process.exitCode = 1;
}
