import type { AgentConfig, IsolationMode, JoinMode, ThinkingLevel } from "./types.js";

interface AgentInvocationParams {
  run_in_background?: boolean;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelInput?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
} {
  return {
    modelInput: agentConfig?.model,
    thinking: agentConfig?.thinking as ThinkingLevel | undefined,
    maxTurns: agentConfig?.maxTurns,
    inheritContext: agentConfig?.inheritContext ?? false,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
    isolated: agentConfig?.isolated ?? false,
    isolation: agentConfig?.isolation,
  };
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined {
  return runInBackground ? defaultJoinMode : undefined;
}
