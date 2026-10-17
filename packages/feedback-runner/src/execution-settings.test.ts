import { describe, expect, it } from "vitest";
import { resolveCodexExecutionSettings } from "./execution-settings.js";
describe("trusted Codex execution settings", () => {
 it("defaults to Sol 6.1/high and upgrades saved Sol choices", () => {
  expect(resolveCodexExecutionSettings()).toEqual({model:"gpt-6.1-sol",reasoningEffort:"high",subagents:"off"});
  expect(resolveCodexExecutionSettings({model:"gpt-6-sol",reasoningEffort:"max"})).toEqual({model:"gpt-6.1-sol",reasoningEffort:"max",subagents:"off"});
  expect(resolveCodexExecutionSettings({model:"gpt-6-astra",reasoningEffort:"ultra"})).toEqual({model:"gpt-6-astra",reasoningEffort:"ultra",subagents:"off"});
 });
 it("rejects unknown values and unsupported Luna reasoning before starting work", () => {
  expect(()=>resolveCodexExecutionSettings({model:"other"} as never)).toThrow();
  expect(()=>resolveCodexExecutionSettings({model:"gpt-6-luna",reasoningEffort:"ultra"})).toThrow();
 });
});

it("allows bounded delegation only when selected by the owner",()=>{
 expect(resolveCodexExecutionSettings({subagents:"auto"})).toMatchObject({subagents:"auto"});
 expect(()=>resolveCodexExecutionSettings({subagents:"yes"} as never)).toThrow();
});
