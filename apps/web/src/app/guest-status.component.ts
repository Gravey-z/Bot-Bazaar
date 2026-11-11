
import {
  Component,
  computed,
  signal,
} from "@angular/core";

import type {
  OnDestroy,
  OnInit,
} from "@angular/core";

type GuestAction = {
  status: "queued" | "signed" | "unknown" | "confirmed" | "failed";
};

type Guest = {
  guestId: string;
  accountId: string;
  status: "provisioning" | "active" | "failed" | "blocked";
  registrationObserved: boolean;
  pendingAction: GuestAction | null;
};

type GuestSession = {
  guest: Guest | null;
  csrfToken: string;
};

type GuestState =
  | "entering"
  | "provisioning"
  | "registration"
  | "throttled"
  | "pending"
  | "ready"
  | "error";

@Component({
  selector: "app-guest-status",
  standalone: true,
  template: `
    <section class="guest-panel" aria-label="Guest account">
      <button
        type="button"
        (click)="startGuest()"
        [disabled]="starting() || guest() !== null"
      >
        {{ guest() ? "Guest mode" : "Play as guest" }}
      </button>

      @if (visible()) {
        <div class="guest-progress" role="status" aria-live="polite">
          <span class="guest-indicator"></span>
          <span>{{ message() }}</span>
        </div>
      }

      @if (guest()?.status === "active") {
        <small>{{ guest()?.accountId }}</small>
      }
    </section>
  `,
  styles: [`
    .guest-panel {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 380px;
    }

    .guest-progress {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      border: 1px solid #a9864d;
      border-radius: 8px;
      background: rgba(30, 23, 15, 0.9);
      color: #f6e5c6;
    }

    .guest-indicator {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #e0b75d;
      flex-shrink: 0;
    }

    small {
      overflow-wrap: anywhere;
      opacity: 0.75;
    }
  `],
})
export class GuestStatusComponent implements OnInit, OnDestroy {
  readonly guest = signal<Guest | null>(null);
  readonly starting = signal(false);
  readonly throttled = signal(false);
  readonly visible = signal(false);
  readonly error = signal(false);

  private csrfToken = "";
  private timer?: ReturnType<typeof setInterval>;
  private refreshing = false;

  readonly state = computed<GuestState>(() => {
    if (this.error()) return "error";
    if (this.throttled()) return "throttled";

    const guest = this.guest();

    if (!guest) return "entering";

    if (guest.status === "failed" || guest.status === "blocked") {
      return "error";
    }

    if (guest.status === "provisioning") {
      return "provisioning";
    }

    if (
      guest.pendingAction?.status === "signed" ||
      guest.pendingAction?.status === "unknown"
    ) {
      return "pending";
    }

    if (
      !guest.registrationObserved ||
      guest.pendingAction?.status === "queued"
    ) {
      return "registration";
    }

    return "ready";
  });

  readonly message = computed(() => {
    switch (this.state()) {
      case "entering":
        return "Entering Bot Bazaar…";
      case "provisioning":
        return "Setting up your guest account…";
      case "registration":
        return "Preparing your game account…";
      case "throttled":
        return "Network is busy. You can still explore the town.";
      case "pending":
        return "Verifying your pending transaction…";
      case "ready":
        return "You're ready to play!";
      case "error":
        return "Guest account setup needs attention.";
    }
  });

  ngOnInit(): void {
    void this.refresh();

    this.timer = setInterval(() => {
      if (!document.hidden) void this.refresh();
    }, 5000);
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }

  async startGuest(): Promise<void> {
    if (this.starting() || this.guest()) return;

    this.starting.set(true);
    this.visible.set(true);

    try {
      await this.refresh();

      if (!this.csrfToken) return;

      const response = await fetch("/api/guest/start", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Guest-CSRF": this.csrfToken,
        },
        body: "{}",
      });

      if (response.status === 429 || response.status === 503) {
        this.throttled.set(true);
        return;
      }

      if (!response.ok) {
        this.error.set(true);
        return;
      }

      const result = await response.json() as {
        guest: Guest;
      };

      this.guest.set(result.guest);
      this.throttled.set(false);
      this.error.set(false);
    } catch {
      this.throttled.set(true);
    } finally {
      this.starting.set(false);
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;

    try {
      const response = await fetch("/api/guest/me", {
        credentials: "include",
        cache: "no-store",
      });

      if (response.status === 429 || response.status === 503) {
        this.throttled.set(true);
        return;
      }

      if (!response.ok) {
        this.error.set(true);
        return;
      }

      const session = await response.json() as GuestSession;

      this.csrfToken = session.csrfToken;
      this.guest.set(session.guest);
      this.throttled.set(false);
      this.error.set(false);

      if (session.guest) {
        this.visible.set(true);
      }
    } catch {
      this.throttled.set(true);
    } finally {
      this.refreshing = false;
    }
  }
}
