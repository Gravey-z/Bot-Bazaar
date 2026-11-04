import { bootstrapApplication } from "@angular/platform-browser";
import { ConfigurationError } from "@bot-bazaar/shared";

import { PUBLIC_CONFIG } from "./app/public-config";
import { loadPublicDeployment } from "./load-public-config";
import { DeploymentSession } from "./app/deployment-session";
import { DEPLOYMENT_SESSION } from "./app/deployment.service";
import { isReplayPage } from "./app/replay-navigation";

async function start(): Promise<unknown> {
  // Historical mode boots without constructing live components, wallet ports,
  // deployment storage, chain clients or worker reads. Returning uses a fresh
  // document and the original selected market's existing storage namespace.
  if (isReplayPage(location.href)) {
    const { ReplayComponent } = await import("./app/replay.component");
    return bootstrapApplication(ReplayComponent);
  }
  const { AppComponent } = await import("./app/app.component");
  return loadPublicDeployment(new URL("config.json", document.baseURI)).then(
    (deployment) => {
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
    },
  );
}
void start().catch((error: unknown) => {
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
