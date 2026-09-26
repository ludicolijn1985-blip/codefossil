#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { runCli } from './run.js';

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readLines: () => createInterface({ input: process.stdin, crlfDelay: Infinity }),
  interactive: process.stdin.isTTY,
});
