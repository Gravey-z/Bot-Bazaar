import { Component, inject } from "@angular/core";
import { PUBLIC_CONFIG } from "./public-config";
import { MarketSceneComponent } from "./market-scene.component";
import { WalletComponent } from "./wallet.component";
import { RegistrationComponent } from "./registration.component";
import { PurchaseComponent } from "./purchase.component";
import { TransactionComponent } from "./transaction.component";
import { ActivityComponent } from "./activity.component";
import { DeploymentComponent } from "./deployment.component";
import { replayPageUrl } from "./replay-navigation";
import { GuestStatusComponent } from "./guest-status.component";

@Component({
  selector: "app-root",
  imports: [
    MarketSceneComponent,
    WalletComponent,
    RegistrationComponent,
    PurchaseComponent,
    TransactionComponent,
    ActivityComponent,
    DeploymentComponent,
    GuestStatusComponent
  ],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent {
  protected readonly config = inject(PUBLIC_CONFIG);
  protected readonly replayUrl = replayPageUrl(location.href, true);
}
