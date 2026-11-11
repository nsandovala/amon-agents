#!/usr/bin/env node
import { runDemo } from './run';

// Dedicated CLI: no dotenv, operational CLI, jobs, event emitter or external input loading.
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--jsonl') || args.length > 1) {
  process.stderr.write('Uso: npm run demo:mission -- [--jsonl]\n');
  process.exitCode = 2;
} else {
  try {
    const demo = runDemo();
    process.stdout.write(args.includes('--jsonl') ? demo.events.map(e => JSON.stringify(e)).join('\n') + '\n' : demo.text + '\n');
  } catch (error) {
    process.stderr.write(`La demostración no cumple sus expectativas: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
