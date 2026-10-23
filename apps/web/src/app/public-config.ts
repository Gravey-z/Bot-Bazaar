import { InjectionToken } from "@angular/core";
import type { PublicConfig } from "@bot-bazaar/shared";

export const PUBLIC_CONFIG = new InjectionToken<PublicConfig>(
  "Bot Bazaar public configuration",
);
