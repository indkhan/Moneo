import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runIsolatedArtifact } from "./run";
const workers: { terminate:ReturnType<typeof vi.fn>; onmessage:((event:{data:{output?:unknown;error?:string}})=>void)|null }[]=[];
beforeEach(()=>{workers.length=0;vi.useFakeTimers();vi.stubGlobal("Worker",class {
  terminate=vi.fn();onmessage:((event:{data:{output?:unknown;error?:string}})=>void)|null=null;onerror:null=null;
  constructor(){workers.push(this);} postMessage(){}
});});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it("terminates a stopped worker immediately and refuses late result writes",async()=>{
  const controller=new AbortController(); const result=runIsolatedArtifact("input=>input",null,controller.signal);
  const assertion=expect(result).rejects.toMatchObject({name:"AbortError"});controller.abort();await assertion;
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  workers[0].onmessage?.({data:{output:"late"}});vi.advanceTimersByTime(6000);expect(workers[0].terminate).toHaveBeenCalledTimes(1);
});
it("starts no worker for an already stopped request and retains the fallback deadline",async()=>{
  const controller=new AbortController();controller.abort();
  await expect(runIsolatedArtifact("input=>input",null,controller.signal)).rejects.toMatchObject({name:"AbortError"});expect(workers).toHaveLength(0);
  const result=runIsolatedArtifact("input=>input",null);const assertion=expect(result).rejects.toThrow("Artifact timed out");vi.advanceTimersByTime(5000);await assertion;expect(workers[0].terminate).toHaveBeenCalledTimes(1);
});
it("completed workers ignore subsequent aborts and duplicate messages",async()=>{
  const controller=new AbortController();const result=runIsolatedArtifact("input=>input",null,controller.signal);
  workers[0].onmessage?.({data:{output:5}});await expect(result).resolves.toBe(5);
  controller.abort();workers[0].onmessage?.({data:{error:"late"}});vi.advanceTimersByTime(6000);
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
});
