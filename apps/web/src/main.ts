import { bootstrapApplication } from "@angular/platform-browser";

import { AppComponent } from "./app/app.component";

bootstrapApplication(AppComponent).catch((error: unknown) => {
  console.error("Bot Bazaar failed to start", error);
  const root = document.querySelector("app-root");
  if (root) {
    root.setAttribute("role", "alert");
    root.textContent =
      "Bot Bazaar could not start. Please refresh the page to try again.";
  }
});
