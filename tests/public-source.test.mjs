import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

test('published source and documentation contain no literal SHA-1 revision references',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
  const revision=/(?<![a-zA-Z0-9])[a-fA-F0-9]{40}(?![a-zA-Z0-9])/;
  const matches=[];
  for(const file of files){
    const bytes=await readFile(new URL('../'+file,import.meta.url));
    if(!bytes.includes(0)&&revision.test(bytes.toString('utf8')))matches.push(file);
  }
  assert.deepEqual(matches,[],'Keep revision references in private evidence; public verification uses version labels and SHA-256 fingerprints.');
});
