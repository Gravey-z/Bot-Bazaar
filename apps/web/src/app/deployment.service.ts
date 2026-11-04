import { InjectionToken } from "@angular/core";
import type { DeploymentSession } from "./deployment-session";

export const DEPLOYMENT_SESSION = new InjectionToken<DeploymentSession>(
  "Pinned browser market selection",
);
