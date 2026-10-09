export interface CodexExecutionSettings {
  model?: "gpt-6.1-sol" | "gpt-6-sol" | "gpt-6-luna" | "gpt-6-astra";
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
}
/** Resolve trusted adapter configuration, including saved pre-upgrade work. */
export function resolveCodexExecutionSettings(input: CodexExecutionSettings = {}) {
  const model = input.model === "gpt-6-sol" ? "gpt-6.1-sol" : input.model ?? "gpt-6.1-sol";
  const reasoningEffort = input.reasoningEffort ?? "high";
  if (!["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"].includes(model) ||
      !["low", "medium", "high", "xhigh", "max", "ultra"].includes(reasoningEffort) ||
      model === "gpt-6-luna" && reasoningEffort === "ultra") throw new Error("Unsupported Codex execution settings");
  return { model, reasoningEffort };
}

/** Older clients do not advertise Sol 6.1/Luna to ChatGPT subscription sessions. */
export function assertCodexModelCliVersion(output: string) {
  const match = /\bcodex-cli (\d+)\.(\d+)\.(\d+)\b/.exec(output);
  if (!match || !(Number(match[1]) > 0 || Number(match[2]) >= 162)) throw new Error("Codex CLI 0.162.0 or newer is required for Sol 6.1 and Luna");
}
