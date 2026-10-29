import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname,basename} from 'node:path';

export async function removeTestRoot(root){
  const target=resolve(root),base=resolve(tmpdir());
  if(dirname(target)!==base||!/^trace-(?:studio-test|app)-[a-z0-9]+$/i.test(basename(target)))throw Error('Refusing cleanup outside a trace test temporary directory');
  // Windows can report ENOTEMPTY/EPERM briefly after worker handles close.
  // Use bounded native retries; other errors and permanent failures still fail.
  await rm(target,{recursive:true,maxRetries:3,retryDelay:50});
}
