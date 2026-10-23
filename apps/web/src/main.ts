import { bootstrapApplication } from "@angular/platform-browser";
import { ConfigurationError } from "@bot-bazaar/shared";

import { AppComponent } from "./app/app.component";
import { PUBLIC_CONFIG } from "./app/public-config";
import { loadPublicConfig } from "./load-public-config";

loadPublicConfig(new URL("config.json", document.baseURI))
  .then((config) =>
    bootstrapApplication(AppComponent, {
      providers: [{ provide: PUBLIC_CONFIG, useValue: config }],
    }),
  )
  .catch((error: unknown) => {
    console.error("Bot Bazaar failed to start", error);
    const root = document.querySelector("app-root");
    if (root) {
      root.setAttribute("role", "alert");
      root.textContent =
        error instanceof ConfigurationError
          ? error.message
          : "Bot Bazaar could not start. Please refresh the page to try again.";
    }
  });
