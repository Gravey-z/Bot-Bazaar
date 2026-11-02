import { Component, inject } from "@angular/core";
import { merchantNames } from "@bot-bazaar/shared";
import { PUBLIC_CONFIG } from "./public-config";

@Component({
  selector: "app-root",
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent {
  protected readonly config = inject(PUBLIC_CONFIG);
  protected readonly merchants = [
    {
      id: "rex",
      name: merchantNames.rex,
      initial: "R",
      role: "The crystal restocker",
      description:
        "Quick to spot a crystal shortage. Looks to replenish stock while keeping gold in reserve.",
      specialty: "Crystals",
      color: "sage",
    },
    {
      id: "luna",
      name: merchantNames.luna,
      initial: "L",
      role: "The careful supplier",
      description:
        "A measured trader. Supplies crystals and protects the resources she needs to keep her stall running.",
      specialty: "Crystals & herbs",
      color: "lavender",
    },
    {
      id: "bolt",
      name: merchantNames.bolt,
      initial: "B",
      role: "The bargain hunter",
      description:
        "Keeps an eye on wood and iron deals. Happy to wait when the price or reserves aren’t right.",
      specialty: "Wood & iron",
      color: "peach",
    },
  ] as const;
}
