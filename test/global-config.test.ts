import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../src/settings.js";
import { configurationWizard } from "../src/config-wizard.js";
import { OpenAGIBridge } from "../src/upstream-bridge.js";
import { prepareIsolation, validateIsolation } from "../src/isolation.js";
import { runChecks } from "../src/workspace.js";
const config = (id: string) => ({version:2, providers:{global:{type:"openai-compatible",baseURL:"https://models.example.test/v1",apiKey:"global-fixture-secret"}},models:{heavy:{providerID:"global",modelID:id},light:{providerID:"global",modelID:"light"}},jev:{type:"typesafe",apiKey:"global-jev-fixture"}});
async function fixture(t: { after(fn: () => Promise<void> | void): void }) {
 const parent=await mkdtemp(join(tmpdir(),"openagi-global-"));
 const root=join(parent,"application"); const a=join(parent,"project-a"); const b=join(parent,"project-b");
 for(const dir of [root,a,b]){await mkdir(join(dir,".openagi"),{recursive:true});await writeFile(join(dir,".openagi/config.json"),JSON.stringify(config(dir===root?"shared-heavy":"project-override")));}
 const previous=process.env.OPENAGI_ROOT;process.env.OPENAGI_ROOT=root;
 t.after(async()=>{if(previous===undefined)delete process.env.OPENAGI_ROOT;else process.env.OPENAGI_ROOT=previous;await rm(parent,{recursive:true,force:true});});
 return {root,a,b,file:join(root,".openagi/config.json")};
}
test("all projects read the application root credentials and model choices, ignoring project overrides",async t=>{
 const {root,a,b,file}=await fixture(t);
 const first=await loadSettings(a);const second=await loadSettings(b);
 assert.equal(first.file,await realpath(file));assert.equal(second.file,first.file);
 assert.equal(first.settings.models.heavy.modelID,"shared-heavy");assert.deepEqual(first.settings,second.settings);
 assert.equal(second.jevKey,"global-jev-fixture");
 const originalA=await readFile(join(a,".openagi/config.json"),"utf8");
 await configurationWizard(b,{write(){},ask:async prompt=>prompt.includes("Light model")?"2":"3",secret:async()=>{throw new Error("Existing credentials must be reused");}},undefined,{fetch:async()=>new Response(JSON.stringify({data:[{id:"heavy"},{id:"next-light"}]}),{headers:{"content-type":"application/json"}})});
 assert.equal((await loadSettings(a)).settings.models.light.modelID,"next-light");
 assert.equal((await loadSettings(b)).settings.models.light.modelID,"next-light");
 assert.equal(await readFile(join(a,".openagi/config.json"),"utf8"),originalA);
 assert.equal((await loadSettings(a,".openagi/config.json")).settings.models.heavy.modelID,"project-override");
 assert.equal(root,process.env.OPENAGI_ROOT);
});
test("native project switching shows identical global choices and reloads changed settings",{skip:process.platform!=="darwin"},async t=>{
 const {root,a,b,file}=await fixture(t);const cli=join(root,"stub-cli");
 await writeFile(cli,`#!/usr/bin/env node
const http=require('node:http'),fs=require('node:fs');const args=process.argv.slice(2);const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
fs.writeFileSync('.openagi/runtime/public-models.json',JSON.stringify({model:config.model,models:Object.keys(config.providers['openagi-config-global'].models),globalKey:config.providers['openagi-config-global'].settings.apiKey==='global-fixture-secret'}));
const view='.openagi/runtime/stub-workflow.json';
http.createServer(async(req,res)=>{res.setHeader('content-type','application/json');const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
if(req.url==='/api/session'&&req.method==='POST'){const data={id:'ses_workflow',location:body.location,metadata:body.metadata,title:body.title};fs.writeFileSync(view,JSON.stringify(data));res.end(JSON.stringify({data}));return;}
if(req.url.startsWith('/api/session?')){res.end(JSON.stringify({data:fs.existsSync(view)?[JSON.parse(fs.readFileSync(view))]:[],cursor:{}}));return;}
if(req.url==='/api/session/ses_workflow'){if(!fs.existsSync(view)){res.statusCode=404;res.end('{}');return;}const data=JSON.parse(fs.readFileSync(view));if(req.method==='PATCH'){fs.writeFileSync(view,JSON.stringify({...data,...body}));res.statusCode=204;res.end();return;}res.end(JSON.stringify({data}));return;}
if(req.url.endsWith('/prompt')){fs.writeFileSync('.openagi/runtime/unexpected-prompt','true');res.statusCode=500;res.end('{}');return;}
res.end(JSON.stringify(req.url.startsWith('/api/plugin')?{data:[{id:'openagi.project.guard',state:{status:'active'}}]}:{version:'2.0.26'}));}).listen(Number(args[args.indexOf('--port')+1]),'127.0.0.1');
`,{mode:0o755});
 const bridge=new OpenAGIBridge({cli});t.after(()=>bridge.close());
 await bridge.project(a);await bridge.project(b);
 assert(bridge.state().projects.every(project=>project.config?.heavy==="global/shared-heavy"));
 assert(bridge.state().projects.every(project=>project.phase==="idle"&&project.mainSessionId==="ses_workflow"));assert.equal(bridge.state().sessions.length,2);assert(bridge.state().sessions.every(session=>session.mode==="workflow"));
 for(const dir of [a,b]){const meta=JSON.parse(await readFile(join(dir,".openagi/runtime/public-models.json"),"utf8"));assert.equal(meta.globalKey,true);assert.equal(meta.model,"openagi-config-global/shared-heavy");}
 await writeFile(file,JSON.stringify(config("new-heavy")));
 await bridge.project(a);await bridge.project(b);
 assert(bridge.state().projects.every(project=>project.config?.heavy==="global/new-heavy"));
 for(const dir of [a,b])await assert.rejects(readFile(join(dir,".openagi/runtime/unexpected-prompt")),{code:"ENOENT"});
});
test("sharing the root config does not allow a project's sandbox to read it or sibling projects",{skip:process.platform!=="darwin"},async t=>{
 const {a,b,file}=await fixture(t);const isolation=await prepareIsolation(a,file);await validateIsolation(isolation);
 const results=await runChecks(a,[{name:"global config is private",command:process.execPath,args:["-e","require('node:fs').readFileSync(process.argv[1])",file],timeoutMs:5000},{name:"sibling is outside scope",command:process.execPath,args:["-e","require('node:fs').readFileSync(process.argv[1])",join(b,".openagi/config.json")],timeoutMs:5000}],undefined,isolation);
 assert(results.every(result=>!result.ok)); assert(results.every(result=>/operation not permitted|EACCES|EPERM/i.test(result.stderr)));
});
