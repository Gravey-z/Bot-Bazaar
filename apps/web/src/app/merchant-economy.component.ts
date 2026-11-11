import { Component, input } from "@angular/core";
import type { merchantEconomy } from "./living-town-merchants";
@Component({
  selector: "app-merchant-economy",
  standalone: true,
  templateUrl: "./merchant-economy.component.html",
  styleUrl: "./merchant-economy.component.css",
})
export class MerchantEconomyComponent {
  readonly view = input.required<ReturnType<typeof merchantEconomy>>();
}
