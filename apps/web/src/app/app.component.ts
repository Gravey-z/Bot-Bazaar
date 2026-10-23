import { Component } from "@angular/core";
import { merchantNames } from "@bot-bazaar/shared";

@Component({
  selector: "app-root",
  templateUrl: "./app.component.html",
})
export class AppComponent {
  protected readonly merchants = Object.values(merchantNames).join(", ");
}
