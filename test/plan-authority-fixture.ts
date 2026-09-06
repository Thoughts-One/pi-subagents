import { readFileSync } from "node:fs";

export const planAuthorityModel = (JSON.parse(
  readFileSync(new URL("../plan-authority-contract.json", import.meta.url), "utf8"),
) as { authority_model: string }).authority_model;
