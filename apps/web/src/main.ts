import { bootstrapApplication } from "@angular/platform-browser";
import { ConfigurationError } from "@bot-bazaar/shared";

import { AppComponent } from "./app/app.component";
import { PUBLIC_CONFIG } from "./app/public-config";
import { loadPublicDeployment } from "./load-public-config";
import { DeploymentSession } from "./app/deployment-session";
import { DEPLOYMENT_SESSION } from "./app/deployment.service";

loadPublicDeployment(new URL("config.json", document.baseURI))
  .then((deployment) => {
    const session = new DeploymentSession(
      deployment,
      {
        get length() {
          return sessionStorage.length;
        },
        key: (index) => sessionStorage.key(index),
        getItem: (key) => sessionStorage.getItem(key),
        setItem: (key, value) => sessionStorage.setItem(key, value),
        removeItem: (key) => sessionStorage.removeItem(key),
      },
      location.href,
    );
    return bootstrapApplication(AppComponent, {
      providers: [
        { provide: PUBLIC_CONFIG, useValue: session.selected },
        { provide: DEPLOYMENT_SESSION, useValue: session },
      ],
    });
  })
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
