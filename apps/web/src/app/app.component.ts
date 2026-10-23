import { Component, inject } from "@angular/core";
import { merchantNames } from "@bot-bazaar/shared";
import { PUBLIC_CONFIG } from "./public-config";

@Component({
  selector: "app-root",
  templateUrl: "./app.component.html",
})
export class AppComponent {
  protected readonly config = inject(PUBLIC_CONFIG);
  protected readonly merchants = Object.values(merchantNames).join(", ");
}
