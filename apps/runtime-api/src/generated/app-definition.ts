import type { AppDefinition } from "@form-builder/contracts";
import { defaultApp } from "../domain/apps/default-app.js";

// This file is overwritten by the compiler when generating a deployable bundle.
// Keeping a default here makes local dev/test work out-of-the-box.
export const appDefinition: AppDefinition = defaultApp;

