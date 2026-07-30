#!/usr/bin/env node
/** Newline-delimited JSON entrypoint for the local application browser worker. */
import readline from 'node:readline';
import { ApplyWorker } from './apply-worker-core.mjs';

const worker = new ApplyWorker({ launchOptions: { profileDir: process.env.CAREER_OPS_BROWSER_PROFILE } });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
    const result = await worker.dispatch(request);
    process.stdout.write(`${JSON.stringify({ id: request.id ?? null, itemId: request.payload?.item?.id ?? null, ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: request?.id ?? null, itemId: request?.payload?.item?.id ?? null, ok: false, error: { code: 'worker_error', message: error.message }, status: 'failed', state: 'NeedsUserAction' })}\n`);
  }
}

await worker.close().catch(() => {});
