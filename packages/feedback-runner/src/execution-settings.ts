export interface CodexExecutionSettings {
  subagents?: "off" | "auto";
  model?: "gpt-6.1-sol" | "gpt-6-sol" | "gpt-6-luna" | "gpt-6-astra";
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
}
/** Resolve trusted adapter configuration, including saved pre-upgrade work. */
export function resolveCodexExecutionSettings(input: CodexExecutionSettings = {}) {
  const model = input.model === "gpt-6-sol" ? "gpt-6.1-sol" : input.model ?? "gpt-6.1-sol";
  const reasoningEffort = input.reasoningEffort ?? "high";
  const subagents = input.subagents ?? "off";
  if (!["off", "auto"].includes(subagents) || !["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"].includes(model) ||
      !["low", "medium", "high", "xhigh", "max", "ultra"].includes(reasoningEffort) ||
      model === "gpt-6-luna" && reasoningEffort === "ultra") throw new Error("Unsupported Codex execution settings");
  return { model, reasoningEffort, subagents };
}

/** Older clients do not advertise Sol 6.1/Luna to ChatGPT subscription sessions. */
export function assertCodexModelCliVersion(output: string) {
  const match = /\bcodex-cli (\d+)\.(\d+)\.(\d+)\b/.exec(output);
  if (!match || !(Number(match[1]) > 0 || Number(match[2]) >= 162)) throw new Error("Codex CLI 0.162.0 or newer is required for Sol 6.1 and Luna");
}

/** Keep all integrations denied. Children inherit the exact named permission profile. */
export function codexSubagentArguments(input: CodexExecutionSettings = {}): string[] {
 const settings = resolveCodexExecutionSettings(input);
 return [settings.subagents === "auto" ? "--enable" : "--disable", "multi_agent",
  "-c", `agents.enabled=${settings.subagents === "auto"}`,
  "-c", "agents.max_concurrent_threads_per_session=2",
  "-c", `agents.default_subagent_model=${JSON.stringify(settings.model)}`,
  "-c", `agents.default_subagent_reasoning_effort=${JSON.stringify(settings.reasoningEffort)}`];
}
export function subagentInstructions(input: CodexExecutionSettings = {}): string {
 return resolveCodexExecutionSettings(input).subagents === "auto"
 ? "The owner authorizes up to two subagents when useful. Delegate independent work if it helps; wait for their results and close them before finishing. Use the selected parent model and reasoning. All agents inherit the same restricted permissions and shared budget."
 : "Do not spawn subagents. The owner selected single-agent work.";
}

export function boundedOwnerInstructions(value: unknown): string {
 if(value === undefined)return "";
 if(typeof value !== "string" || value.length>5000)throw new Error("Invalid owner instructions");
 return value;
}
