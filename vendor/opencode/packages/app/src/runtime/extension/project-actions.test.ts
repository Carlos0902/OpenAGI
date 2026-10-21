import { describe, expect, test } from "bun:test"
import type { ProjectManager } from "@opencode/gui-extensions/sdk"
import { ServerConnection } from "../server/registry"
import { createManagedProjectActions, shouldRegisterProject } from "./project-actions"
const base:ServerConnection.Sidecar={type:"sidecar",variant:"base",http:{url:"http://127.0.0.1:1"}}
const remote:ServerConnection.Http={type:"http",http:{url:"https://remote.example"}}
const own:ServerConnection.Extension={type:"extension",key:"project:a",extension:"project",state:"ready",presentation:"project",projectDirectory:"/a",http:{url:"http://127.0.0.1:2"},connecting:false,authenticationRequired:false,managed:false}
describe("native managed project actions",()=>{
 test("native folder selection resolves and registers the project's real transport without starting a task",async()=>{
  const calls:string[]=[]
  const manager:ProjectManager={handles:input=>input.builtin||input.server==="project:a",choose:async()=>({server:"project:a",directory:"/a"}),add:async directories=>directories.map(directory=>({server:"project:a",directory})),select:target=>{calls.push(`select:${target.directory}`)},start:async target=>{calls.push(`start:${target.directory}`)},close:async()=>{calls.push("pause")},remove:async()=>{calls.push("forget")}}
  const actions=createManagedProjectActions({managers:()=>[manager],resolve:async target=>{calls.push(`register:${target.directory}`);return {server:own,directory:target.directory}},closeTabs:key=>calls.push(`tabs:${key}`)})
  expect(actions.handles(base)).toBe(true);expect(actions.handles(remote)).toBe(false)
  expect(await actions.choose(base)).toEqual({server:own,directory:"/a"});expect(calls).toEqual(["register:/a"])
  await actions.select(own,"/a");await actions.start(own,"/a");await actions.close(own,"/a")
  expect(calls.slice(1)).toEqual(["select:/a","start:/a","pause"])
  await actions.remove(own,"/a");expect(calls.slice(-2)).toEqual(["forget","tabs:project:a"])
  await actions.remove(remote,"/a");expect(calls.slice(-2)).toEqual(["forget","tabs:project:a"])
 })
 test("restored native project registration respects original closed state and avoids poll-driven reopening",()=>{
  const target={server:"project:a",directory:"/a"}
  expect(shouldRegisterProject(target,[],new Set())).toBe(true)
  expect(shouldRegisterProject(target,["/a"],new Set())).toBe(false)
  expect(shouldRegisterProject(target,[],new Set(["project:a\0/a"]))).toBe(false)
 })
})
