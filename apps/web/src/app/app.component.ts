import { Component, inject } from "@angular/core";
import { PUBLIC_CONFIG } from "./public-config";
import { MarketSceneComponent } from "./market-scene.component";
import { WalletComponent } from "./wallet.component";

@Component({
  selector: "app-root",
  imports: [MarketSceneComponent, WalletComponent],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent {
  protected readonly config = inject(PUBLIC_CONFIG);
}
