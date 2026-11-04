import { Component, inject, signal } from "@angular/core";
import type { OnDestroy, OnInit } from "@angular/core";
import { DEPLOYMENT_SESSION } from "./deployment.service";

@Component({
  selector: "app-deployment",
  templateUrl: "./deployment.component.html",
  styleUrl: "./deployment.component.css",
})
export class DeploymentComponent implements OnInit, OnDestroy {
  protected readonly selection = inject(DEPLOYMENT_SESSION);
  protected readonly state = signal(this.selection.view());
  protected readonly reviewing = signal(false);
  protected readonly message = signal("");
  private timer?: ReturnType<typeof setInterval>;
  private readonly update = (): void => {
    if (!document.hidden) this.state.set(this.selection.view());
  };
  ngOnInit(): void {
    this.timer = setInterval(this.update, 1000);
    document.addEventListener("visibilitychange", this.update);
  }
  ngOnDestroy(): void {
    clearInterval(this.timer);
    document.removeEventListener("visibilitychange", this.update);
  }
  protected openPublished(): void {
    try {
      this.selection.selectPublished();
      location.reload();
    } catch {
      this.message.set(
        "The market switch is blocked. Check the original wallet transaction or saved records first.",
      );
      this.update();
    }
  }
}
