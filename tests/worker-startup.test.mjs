import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

test('import sent during extension initialization is retained',async()=>{
  const run=await promisify(execFile)(process.execPath,['--experimental-vm-modules',fileURLToPath(new URL('./worker-startup-harness.mjs',import.meta.url))],{timeout:10000});
  assert.match(run.stdout,/early import completed/);
});
