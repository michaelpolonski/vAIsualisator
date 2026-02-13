import type { AppDefinition } from "@form-builder/contracts";
import { defaultApp } from "./apps/default-app.js";

const apps = new Map<string, AppDefinition>([[defaultApp.appId, defaultApp]]);

export function getAppDefinition(appId: string): AppDefinition | undefined {
  return apps.get(appId);
}
