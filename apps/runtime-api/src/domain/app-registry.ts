import type { AppDefinition } from "@form-builder/contracts";
import { appDefinition } from "../generated/app-definition.js";

const apps = new Map<string, AppDefinition>([[appDefinition.appId, appDefinition]]);

export function getAppDefinition(appId: string): AppDefinition | undefined {
  return apps.get(appId);
}
