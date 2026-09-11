import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function setup(name) {
  if (!process.env.OCTOS_LIVE_REVIEW_URL || !process.env.OCTOS_LIVE_REVIEW_CREDENTIALS)
    throw Error('Set OCTOS_LIVE_REVIEW_URL and OCTOS_LIVE_REVIEW_CREDENTIALS for an isolated server.');
  const base = new URL(process.env.OCTOS_LIVE_REVIEW_URL);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const c = JSON.parse(await readFile(process.env.OCTOS_LIVE_REVIEW_CREDENTIALS,'utf8'));
  if (![c.a,c.b,c.owner].every(a=>a?.email?.endsWith('@example.invalid')))
    throw Error('These live mutation checks require synthetic @example.invalid accounts.');
  const directory=resolve(process.env.OCTOS_LIVE_REVIEW_OUTPUT || 'test-results/live-review-features',name);
  await mkdir(directory,{recursive:true,mode:0o700});
  return {root:pathToFileURL(directory+'/'),c,base:base.href,origin:base.origin};
}
