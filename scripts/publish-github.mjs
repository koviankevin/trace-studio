// Publish only this project's allowlisted source; credentials stay inside GitHub CLI.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('../',import.meta.url));
if(path.resolve(process.cwd())!==path.resolve(cwd))throw Error('Run from the project directory');
const gh=process.env.GH_EXECUTABLE||'H:\\mc2llvm\\.work\\gh\\bin\\gh.exe';
const git=process.env.GIT_EXECUTABLE||'git';const repo='koviankevin/trace-studio';
const run=(exe,args)=>execFileSync(exe,args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const api=(endpoint,method='GET',body)=>JSON.parse(execFileSync(gh,['api',endpoint,'--method',method,...(body?['--input','-']:[])],{cwd,encoding:'utf8',input:body?JSON.stringify(body):undefined}));
if(!fs.existsSync('.git'))run(git,['init','--initial-branch=main']);
const remote=`https://github.com/${repo}.git`;
try{if(run(git,['remote','get-url','origin'])!==remote)throw Error('Wrong remote');}catch(e){if(e.message==='Wrong remote')throw e;run(git,['remote','add','origin',remote]);}
// Distribute the license alongside browser JavaScript, including the adapted navigation.
for(const name of ['LICENSE','NOTICE'])fs.copyFileSync(name,path.join('dist',name));
fs.writeFileSync('dist/.nojekyll','');
run(process.execPath,['--test',...fs.readdirSync('tests').filter(n=>n.endsWith('.test.mjs')).map(n=>'tests/'+n)]);
run(git,['add','--','.gitignore','package.json','server.mjs','dist','tests','scripts','docs','README.md','LICENSE','NOTICE']);
// Recovery for this new repository's first, rejected push only. Preserve its
// unpublished workflow draft before creating a clean root with the tested tree.
let remoteMain='';try{remoteMain=run(git,['ls-remote','--heads','origin','main']);}catch(e){throw e;}
const workflowTracked=run(git,['ls-files','.github/workflows/pages.yml']);
if(!remoteMain&&workflowTracked){
  run(git,['rm','--cached','--','.github/workflows/pages.yml']);
  const old=run(git,['rev-parse','HEAD']);run(git,['branch','unpublished-workflow-draft',old]);
  const tree=run(git,['write-tree']);
  const initial=run(git,['-c','user.name=koviankevin','-c','user.email=koviankevin@users.noreply.github.com','commit-tree',tree,'-m','feat: launch 時跡 Trace Studio JSON trace workspace']);
  run(git,['update-ref','refs/heads/main',initial,old]);
}
if(run(git,['diff','--cached','--name-only']))run(git,['-c','user.name=koviankevin','-c','user.email=koviankevin@users.noreply.github.com','commit','-m','feat: launch 時跡 Trace Studio JSON trace workspace']);
run(git,['push','--set-upstream','origin','main']);
const pagesCommit=run(git,['subtree','split','--prefix','dist','HEAD']);
run(git,['push','origin',pagesCommit+':refs/heads/gh-pages']);
const configuration={build_type:'legacy',source:{branch:'gh-pages',path:'/'}};
let pages;try{pages=api(`repos/${repo}/pages`);}catch{pages=api(`repos/${repo}/pages`,'POST',configuration);}
if(pages.build_type!=='legacy'||pages.source?.branch!=='gh-pages')pages=api(`repos/${repo}/pages`,'PUT',configuration);
console.log(JSON.stringify({repository:remote,commit:run(git,['rev-parse','HEAD']),pagesCommit,pages:pages.html_url,buildType:pages.build_type},null,2));
