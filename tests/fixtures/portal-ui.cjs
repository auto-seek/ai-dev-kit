// Perspective: reviewers exercising the portal through a real browser.
// Invariant: UI examples use only temporary local Git/SQLite state and fixture identities.
// Goal: reproduce navigation, draft, media, error and uncertain-response paths without production writes.
// Migration: retain this isolated harness with portal UI verification; it is not a deployed entrypoint.
"use strict";
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const {execFileSync} = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const {authFixture, PASSWORD} = require('./portal-auth.cjs');
const {startPortal, nativeSpecs} = require(path.join(repo, 'scripts/cascade-portal.cjs'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-center-ui-fixture-'));
const writer = path.join(root, 'writer'), remote = path.join(root, 'remote.git');
fs.mkdirSync(writer);
const git = args => execFileSync('git', args, {cwd:writer,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git(['init','--bare','--quiet',remote]); git(['init','--quiet']);git(['config','user.name','Local UI fixture']);git(['config','user.email','fixture@example.invalid']);
fs.mkdirSync(path.join(writer,'data'));
let graph = {epoch:1,lamport:0,nodes:{root:{id:'root',state:'COMPLETED',context:{critical:{title:'本地 UI 验证项目'}}}},edges:[]};
function commit(){fs.writeFileSync(path.join(writer,'data/graph.json'),JSON.stringify(graph));fs.writeFileSync(path.join(writer,'data/events.jsonl'),'');git(['add','.']);git(['commit','--quiet','--allow-empty','-m','Local fixture snapshot']);git(['push','--quiet',remote,'HEAD:refs/heads/cascade-state/ui-fixture']);}
commit();
const proxySecret = 'local-ui-fixture-proxy-not-a-production-secret';
const agentToken = 'local-ui-fixture-center-not-a-production-secret';
let portal, proxy;
const port = Number(process.env.PORTAL_UI_PORT || 4328);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid fixture port');
const outer = `http://127.0.0.1:${port}`;
const controlFile = path.join(root, 'control.json');
const logFile = path.join(root, 'http.jsonl');
fs.writeFileSync(controlFile, '{}');
async function main(){
 portal=await startPortal({remote,namespace:'ui-fixture',project:'本地演示 · UI 验证',rootTask:'root',dataDir:path.join(root,'portal'),proxySecret,agentToken,localDevelopment:true,port:0,refreshMs:1000,...authFixture(root,['ui-reviewer','second-reviewer']), ...(process.env.PORTAL_UI_IDLE_MS ? {authOptions:{idleMs:Number(process.env.PORTAL_UI_IDLE_MS)}} : {})});
 const signedIn=await fetch(portal.url+'/api/auth/login',{method:'POST',headers:{'x-cascade-proxy':proxySecret,origin:portal.url,'content-type':'application/json'},body:JSON.stringify({username:'ui-reviewer',password:PASSWORD})});
 if(!signedIn.ok)throw new Error('Fixture login failed');const cookie=signedIn.headers.get('set-cookie').split(';')[0], session=await signedIn.json();
 const call=async(route,data,agent=false)=>{const response=await fetch(portal.url+route,{method:data===undefined?'GET':'POST',headers:{'x-cascade-proxy':proxySecret,...agent?{authorization:`Bearer ${agentToken}`}:{cookie,'x-cascade-csrf':session.csrfToken,origin:portal.url},'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const value=await response.json();if(!response.ok)throw new Error(JSON.stringify(value));return value;};
 let r, c, plan;
 if (!process.argv.includes('--empty')) {
 const request=async(description,key)=>call('/api/requests',{description,idempotencyKey:key});
 await request('希望在需求里直接看到相关任务，减少来回查找。','received');
 r=await request('手机上验收候选时，想先看产物再写意见。','question');await call(`/api/agent/requests/${r.id}`,{version:1,action:'question',body:'你主要用手机看截图，还是下载到电脑验证？请补充使用场景。'},true);
 const proposal={title:'让任务进展与需求衔接',goal:'从需求直接找到正在执行的任务。',scope:['门户和任务流的导航与状态说明'],nonGoals:['不更改权限、合同或发布流程'],acceptance:['打开关联任务后显示对应详情，返回可找到原需求'],requiredTier:'pro',baseSha:'0b5def0cecac7955fedda5b41b4105e045aeab84',dependencies:[]};
 r=await request('点开已派单需求，希望直接定位任务。','published');r=await call(`/api/agent/requests/${r.id}`,{version:r.version,action:'plan',proposal},true);r=await call(`/api/agent/requests/${r.id}`,{version:r.version,action:'prepare'},true);
 plan=nativeSpecs(r,'root');
 for(const spec of plan.specs){graph.nodes[spec.node_id]={id:spec.node_id,state:spec.reserved_for?'PENDING':'ACTIVE',required_tier:spec.required_tier,reserved_for:spec.reserved_for??null,context:{summary:spec.reserved_for?'等待实施完成后独立审查。':'本地演示任务，正在整理窄屏交互。',critical:{title:spec.reserved_for?'独立审查导航衔接':'整理需求与任务的导航'}},...spec.reserved_for?{}:{agent_id:'fixture-worker',claim_token:1,claimed_at:Date.now()/1000,timeout:1800}};for(const [from,edge]of Object.entries(spec.deps))graph.edges.push({from,to:spec.node_id,...edge});}
 graph.nodes['fixture-delivered']={id:'fixture-delivered',state:'COMPLETED',context:{summary:'本地测试交付记录；没有游戏截图、录像或试玩包。',critical:{title:'候选反馈本地验证',worker:{publication_verified:true,commit:'0b5def0cecac7955fedda5b41b4105e045aeab84'}}}};commit();
 await call(`/api/agent/requests/${r.id}`,{version:r.version,action:'publish'},true);
 c=await call('/api/agent/candidates',{taskId:'fixture-delivered',sha:'0b5def0cecac7955fedda5b41b4105e045aeab84',title:'候选反馈 · 本地流程演示',summary:'用于检验下载、封存与通过/返工交互。文件是测试说明；没有游戏交付，也不代表技术验收。'},true);
 const bytes=Buffer.from('# 本地 UI 流程验证\n\n此文件由隔离测试环境创建，仅供下载验证。不是游戏候选。\n');
 const upload=await fetch(portal.url+`/api/agent/candidates/${c.id}/artifacts?name=local-ui-verification.md`,{method:'POST',headers:{'x-cascade-proxy':proxySecret,authorization:`Bearer ${agentToken}`,'content-length':String(bytes.length)},body:bytes});if(!upload.ok)throw new Error(await upload.text());
 await call(`/api/agent/candidates/${c.id}/seal`,{},true);
 }

 if (process.argv.includes('--dag')) {
 const entries = [
  ['dag-plan', 'COMPLETED', '明确目标与验收范围', []],
  ['dag-design', 'COMPLETED', '确认任务依赖图的视觉方案', ['dag-plan']],
  ['dag-api', 'ACTIVE', '核对快照接口与任务状态', ['dag-plan']],
  ['dag-ui', 'FAILED', '实现分层布局与交互', ['dag-design']],
  ['dag-docs', 'READY', '整理使用说明与交付证据', ['dag-plan']],
  ['dag-integrate', 'PENDING', '联调分支汇合、跨层连线与长标题在窄屏上的完整显示', ['dag-ui', 'dag-api', 'dag-plan']],
  ['dag-verify', 'PENDING', '独立审查与浏览器验收', ['dag-integrate', 'dag-docs']],
  ['dag-expired', 'ACTIVE', '核实执行租约（过期不等于失败）', []],
  ['dag-cancelled', 'CANCELLED', '已取消的旧方案', []],
  ['dag-rework', 'PENDING', '重新评估受取消任务影响的后续工作', ['dag-cancelled']],
  ['dag-history', 'COMPLETED', '归档已完成的前一轮记录', ['dag-plan']],
  ['dag-archive', 'CANCELLED', '<img src=x onerror=alert(1)> · 历史说明', ['dag-history']],
 ];
 for (const [id, state, title, deps] of entries) {
  graph.nodes[id] = {id, state, required_tier:'pro', context:{summary:'隔离本地浏览器验收数据，不代表线上工作。',critical:{title}}, ...(state === 'ACTIVE' ? {agent_id:'fixture-worker',claim_token:1,claimed_at:Date.now()/1000-(id === 'dag-expired'?3600:0),timeout:1800}:{}), ...(state === 'READY' ? {reserved_for:'fixture-doc-reviewer'}:{})};
  for (const from of deps) graph.edges.push({from,to:id,expectation:`核对 ${from} 的真实交付`,promise:`提供 ${id} 所需的证据；<script> 是普通文本。`});
 }
 commit();
 }

 const assets={'/layout.js':'scripts/cascade-flow/layout.js','/vendor/dagre-3.1.1.esm.js':'scripts/cascade-flow/vendor/dagre-3.1.1.esm.js','/login':'scripts/cascade-portal/index.html','/':'scripts/cascade-portal/index.html','/portal.css':'scripts/cascade-portal/style.css','/portal.js':'scripts/cascade-portal/app.js','/flow':'scripts/cascade-flow/index.html','/style.css':'scripts/cascade-flow/style.css','/app.js':'scripts/cascade-flow/app.js'};
 proxy=http.createServer((req,res)=>{
  if(req.headers.host!==`127.0.0.1:${port}`||req.headers.origin&&req.headers.origin!==outer){res.writeHead(403);res.end();return;}
  const control = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
  fs.appendFileSync(logFile, JSON.stringify({at:new Date().toISOString(),method:req.method,route:req.url})+'\n');
  if (control.getError && req.url === '/api/portal') {res.writeHead(503, {'content-type':'application/json'});res.end(JSON.stringify({error:'本地故障注入：服务暂不可用'}));return;}
  const forward = () => {
  const inner=new URL(portal.url);const headers={...req.headers,host:inner.host,'x-cascade-proxy':proxySecret,'x-real-ip':req.socket.remoteAddress};delete headers.authorization;delete headers['x-cascade-user'];if(req.headers.origin)headers.origin=inner.origin;
  const target=http.request(portal.url+req.url,{method:req.method,headers},upstream=>{if(req.url==='/api/auth/logout' && control.logoutResponseDelayMs){const chunks=[];upstream.on('data',chunk=>chunks.push(chunk));upstream.on('end',()=>setTimeout(()=>{if(!res.destroyed){res.writeHead(upstream.statusCode,upstream.headers);res.end(Buffer.concat(chunks));}},Math.min(10000,control.logoutResponseDelayMs)));return;}if(control.dropReplyResponseOnce && req.method === 'POST' && req.url.endsWith('/reply')) {control.dropReplyResponseOnce=false;fs.writeFileSync(controlFile,JSON.stringify(control));upstream.resume();upstream.on('end',()=>res.destroy());return;}res.writeHead(upstream.statusCode,upstream.headers);const route=new URL(req.url,outer).pathname;if(assets[route]&&req.method==='GET'&&upstream.statusCode===200){upstream.resume();let source=fs.readFileSync(path.join(repo,assets[route]));if(route==='/flow')source=Buffer.from(source.toString().replace('<body>','<body data-portal="true">').replace('<span class="read-only">只读任务流</span>','<a href="/">返回团队中心</a>'));res.end(source);}else upstream.pipe(res);});target.on('error',error=>{if(!res.headersSent)res.writeHead(502);res.end(error.message);});req.pipe(target);
  };
  if (req.method === 'POST' && control.postDelayMs) setTimeout(forward, Math.min(30000, control.postDelayMs)); else forward();
 });await new Promise(resolve=>proxy.listen(port,'127.0.0.1',resolve));
 fs.writeFileSync(path.join(root,'fixture.json'),JSON.stringify({root,url:outer,innerUrl:portal.url,controlFile,logFile,requestId:r?.id,candidateId:c?.id,taskId:plan?.taskIds[0]},null,2));
 console.log(JSON.stringify({url:outer,root,controlFile,kind:'isolated local fixture; no production access'}));
}
let stopping=false;const deadline=setTimeout(()=>void stop(),2*60*60*1000);async function stop(){if(stopping)return;stopping=true;clearTimeout(deadline);if(proxy)await new Promise(resolve=>{proxy.close(resolve);proxy.closeAllConnections();});if(portal)await portal.close();}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());main().catch(async e=>{console.error(e);await stop();process.exitCode=1;});
