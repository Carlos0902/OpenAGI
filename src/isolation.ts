import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withinProject } from "./boundary.js";
import { backendProviderId, type LoadedSettings } from "./settings.js";

export interface Isolation { root: string; runtime: string; profile: string; command: string; args: string[]; environment: NodeJS.ProcessEnv }

export async function prepareIsolation(directory: string, protectedConfig: string): Promise<Isolation> {
  const root = await realpath(directory);
  const runtime = await withinProject(root, ".openagi/runtime");
  await mkdir(runtime, { recursive: true });
  const home = join(runtime, "home");
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, LANG: process.env.LANG ?? "en_US.UTF-8", TERM: process.env.TERM,
    HTTP_PROXY: process.env.HTTP_PROXY ?? process.env.http_proxy, HTTPS_PROXY: process.env.HTTPS_PROXY ?? process.env.https_proxy,
    NO_PROXY: process.env.NO_PROXY ?? process.env.no_proxy ?? "localhost,127.0.0.1,::1",
    HOME: home, OPENCODE_TEST_HOME: home, TMPDIR: join(runtime, "tmp"),
    XDG_CONFIG_HOME: join(runtime, "config"), XDG_DATA_HOME: join(runtime, "data"),
    XDG_CACHE_HOME: join(runtime, "cache"), XDG_STATE_HOME: join(runtime, "state"),
    OPENCODE_CONFIG_DIR: join(runtime, "config", "opencode"), OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_MODELS_PATH: join(runtime, "catalog.json"),
    npm_config_cache: join(runtime, "npm-cache"), npm_config_userconfig: join(runtime, "npmrc"),
    npm_config_globalconfig: join(runtime, "global-npmrc"), npm_config_update_notifier: "false",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "OpenAGI", GIT_AUTHOR_EMAIL: "openagi@localhost", GIT_COMMITTER_NAME: "OpenAGI", GIT_COMMITTER_EMAIL: "openagi@localhost",
  };
  for (const path of [home, environment.TMPDIR!, environment.XDG_CONFIG_HOME!, environment.XDG_DATA_HOME!, environment.XDG_CACHE_HOME!, environment.XDG_STATE_HOME!, environment.OPENCODE_CONFIG_DIR!]) await mkdir(path, { recursive: true });
  await writeFile(environment.npm_config_userconfig!, "", { mode: 0o600 });
  await writeFile(environment.npm_config_globalconfig!, "", { mode: 0o600 });
  await writeFile(environment.OPENCODE_MODELS_PATH!, "{}", { mode: 0o600 });
  const profile = join(runtime, "sandbox.sb");
  if (process.platform !== "darwin") throw new Error("当前严格文件隔离实现使用 macOS sandbox-exec；本平台尚未配置等价沙箱，已停止，避免开放项目外访问。");
  await access("/usr/bin/sandbox-exec");
  const executable = await realpath(process.execPath);
  const toolchain = dirname(dirname(executable));
  const literal = (path: string) => JSON.stringify(path);
  const inputs = join(root, ".openagi", "input-queue.json");
  const inputTemps = `^${inputs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[a-f0-9-]+\\.tmp$`;
  const text = `(version 1)
(allow default)
(deny file-read-data file-write*)
(allow file-read-data (literal "/") (subpath "/$bunfs") (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/dev") (subpath "/private/etc") (subpath "/private/var/db/dyld") (subpath "/private/var/db/timezone") (subpath "/private/var/run") (subpath "/Library/Preferences") (subpath "/Library/Apple") (subpath "/Library/Developer") (subpath "/Library/Frameworks") (subpath "/Applications/Xcode.app") (subpath "/opt/homebrew") (subpath ${literal(toolchain)}))
(allow file-write* (literal "/dev/null") (literal "/dev/tty"))
(allow file-read-data file-write* (subpath ${literal(root)}))
(deny file-read-data file-write* (literal ${literal(protectedConfig)}) (literal ${literal(join(root, ".openagi", "state.json"))}) (literal ${literal(join(root, ".openagi", "lock.json"))}) (literal ${literal(join(root, ".openagi", "usage.jsonl"))}))
(deny file-read-data file-write* (literal ${literal(inputs)}) (regex ${literal(inputTemps)}))
`;
  await writeFile(profile, text, { mode: 0o600 });
  return { root, runtime, profile, command: "/usr/bin/sandbox-exec", args: ["-f", profile], environment };
}

/** Pure translation: OpenAGI's configuration is authoritative; no upstream config or credential store is imported. */
export async function backendConfiguration(loaded: LoadedSettings, isolation: Isolation): Promise<Record<string, unknown>> {
  const settings = loaded.settings;
  const packages = { "openai-compatible": "@opencode/ai/providers/openai-compatible", openai: "@opencode/ai/providers/openai", anthropic: "@opencode/ai/providers/anthropic", google: "@opencode/ai/providers/google" };
  const refs = [settings.models.heavy, settings.models.light].filter((ref): ref is NonNullable<typeof ref> => !!ref);
  const providers = Object.fromEntries(Object.entries(settings.providers).map(([id, provider]) => [backendProviderId(id), {
    name: provider.name ?? id, headers: provider.headers, package: packages[provider.type],
    settings: { baseURL: provider.baseURL, apiKey: loaded.keys[id], ...(provider.type === "openai-compatible" ? { provider: backendProviderId(id) } : {}) },
    models: Object.fromEntries([...new Set([...(provider.models ?? []).map(model => model.id), ...refs.filter(ref => ref.providerID === id).map(ref => ref.modelID)])].map(modelID => {
      const declared = provider.models?.find(model => model.id === modelID);
      return [modelID, { modelID, name: declared?.name ?? modelID, capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: declared?.contextWindow ?? provider.contextWindow, output: declared?.maxOutputTokens ?? provider.maxOutputTokens } }];
    })),
  }]));
  const plugin = join(isolation.runtime, "project-guard");
  await mkdir(plugin, { recursive: true });
  await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "openagi-project-guard", type: "module", main: "index.js" }), { mode: 0o600 });
  await writeFile(join(plugin, "policy.js"), projectGuardSource(isolation.root, loaded.file, Object.keys(providers)), { mode: 0o600 });
  await writeFile(join(plugin, "index.js"), effectGuardSource(Object.keys(providers)), { mode: 0o600 });
  return {
    model: `${backendProviderId(settings.models.heavy.providerID)}/${settings.models.heavy.modelID}`,
    providers, share: "disabled", update: "disable", shell: "/bin/sh", snapshots: false, warming: false, websearch: settings.search ? { provider: settings.search.provider } : false,
    lsp: false, formatter: false,
    plugins: ["-opencode.models.dev", "-opencode.config.instruction", "-opencode.config.skill", plugin],
    permissions: [{ action: "external_directory", resource: "*", effect: "deny" }],
    experimental: { policies: [{ action: "provider.use", resource: "*", effect: "deny" }, ...Object.keys(providers).map(resource => ({ action: "provider.use", resource, effect: "allow" }))] },
  };
}

export function projectGuardSource(root: string, config: string, providers: string[]): string {
  return `import fs from 'node:fs/promises';
import path from 'node:path';
const root=${JSON.stringify(root)}, config=${JSON.stringify(config)}, providers=new Set(${JSON.stringify(providers)});
const inside=value=>{const p=path.relative(root,value);return p===''||(!path.isAbsolute(p)&&p!=='..'&&!p.startsWith('..'+path.sep));};
export async function check(value,base=root){let target=path.resolve(base,value);if(!inside(target))throw Error('OpenAGI: path is outside current project');if(target===config||target.startsWith(path.join(root,'.openagi')+path.sep)&&!target.includes(path.sep+'worktrees'+path.sep))throw Error('OpenAGI: private configuration/runtime files are not model context');let existing=target;while(true){try{await fs.lstat(existing);if(!inside(await fs.realpath(existing)))throw Error('OpenAGI: symlink points outside project');return target;}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(existing);if(parent===existing)throw error;existing=parent;}}}
export async function guardTool(event,base){const name=event.tool.split('.').at(-1),input=event.input??{};
if(['read','glob','grep'].includes(name))await check(input.path??'.',base);
if(['edit','write'].includes(name))await check(input.path??input.filePath??input.file_path??'.',base);
if(name==='patch'){for(const match of String(input.patch??input.patchText??input.patch_text??'').matchAll(/\\*\\*\\* (?:Add File|Update File|Delete File|Move to): (.+)/g))await check(match[1].trim(),base);}}
export default {id:'openagi.project.guard',async setup(ctx){
await check(ctx.location.directory);
const allowed=new Set(['read','glob','grep','edit','write','patch','shell','webfetch','websearch','question']);
await ctx.tool.transform(editor=>{for(const tool of editor.list())if(!allowed.has(tool.name))editor.remove(tool.id);});
await ctx.permission.hook('evaluate',event=>{if(event.action==='external_directory'){event.effect='deny';event.message='OpenAGI restricts access to the current project';}});
await ctx.tool.hook('execute.before',event=>guardTool(event,ctx.location.directory));
await ctx.shell.hook('create.before',async event=>{await check(event.cwd);for(const key of Object.keys(event.env))if(/API_KEY|TOKEN|SECRET|PASSWORD|OPENCODE_CONFIG_CONTENT/.test(key))delete event.env[key];});
await ctx.provider.transform(editor=>{for(const entry of editor.list())if(!providers.has(entry.provider.id))editor.remove(entry.provider.id);});
await ctx.session.hook('context',async event=>{const file=path.join(ctx.location.directory,'AGENTS.md');await check(file);try{const text=await fs.readFile(file,'utf8');event.system.push({type:'text',text:'Instructions from current project: '+file+'\\n'+text});}catch(error){if(error.code!=='ENOENT')throw error;}});
await ctx.session.hook('title',event=>{event.result='OpenAGI task';});
}};
`;
}

/** Use the upstream typed Tool.Error channel so a denied path is a normal failed tool call, not a crashed plugin. */
function effectGuardSource(providers: string[]): string {
  return `import fs from 'node:fs/promises';
import path from 'node:path';
import {Effect} from 'effect';
import {Error as ToolError} from '@opencode/plugin/promise/tool';
import {check,guardTool} from './policy.js';
const providers=new Set(${JSON.stringify(providers)});
export default {id:'openagi.project.guard',effect:ctx=>Effect.gen(function*(){
yield* Effect.promise(()=>check(ctx.location.directory));
yield* ctx.tool.transform(editor=>{const allowed=new Set(['read','glob','grep','edit','write','patch','shell','webfetch','websearch','question']);for(const tool of editor.list())if(!allowed.has(tool.name))editor.remove(tool.id);});
yield* ctx.permission.hook('evaluate',event=>Effect.sync(()=>{if(event.action==='external_directory'){event.effect='deny';event.message='OpenAGI restricts access to the current project';}}));
yield* ctx.tool.hook('execute.before',event=>Effect.tryPromise({try:()=>guardTool(event,ctx.location.directory),catch:error=>new ToolError({message:error instanceof Error?error.message:String(error)})}));
yield* ctx.shell.hook('create.before',event=>Effect.promise(async()=>{await check(event.cwd);for(const key of Object.keys(event.env))if(/API_KEY|TOKEN|SECRET|PASSWORD|OPENCODE_CONFIG_CONTENT/.test(key))delete event.env[key];}));
yield* ctx.provider.transform(editor=>{for(const entry of editor.list())if(!providers.has(entry.provider.id))editor.remove(entry.provider.id);});
yield* ctx.session.hook('context',event=>Effect.promise(async()=>{const file=path.join(ctx.location.directory,'AGENTS.md');await check(file);try{const text=await fs.readFile(file,'utf8');event.system.push({type:'text',text:'Instructions from current project: '+file+'\\n'+text});}catch(error){if(error.code!=='ENOENT')throw error;}}));
yield* ctx.session.hook('title',event=>Effect.sync(()=>{event.result='OpenAGI task';}));
})};
`;
}

export async function validateIsolation(isolation: Isolation): Promise<void> {
  await promisify(execFile)(isolation.command, [...isolation.args, "/bin/sh", "-c", "true"], { cwd: isolation.root, env: isolation.environment, timeout: 5_000 });
}
