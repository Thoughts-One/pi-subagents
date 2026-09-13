import type { SteerResult } from "./types.js";

export function formatSteerResult(result: SteerResult, subject: string): { text: string; isError: boolean } {
  if (result.status === "accepted") {
    return { text: `Steering message accepted for ${subject}.`, isError: false };
  }
  if (result.status === "queued") {
    return { text: `Steering message queued for ${subject}.`, isError: false };
  }
  const detail = result.detail ? `: ${result.detail}` : "";
  return { text: `Steering rejected for ${subject}: ${result.reason}${detail}.`, isError: true };
}
