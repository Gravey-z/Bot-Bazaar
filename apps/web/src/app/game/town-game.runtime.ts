import Phaser from "phaser";
import {
  TownGameBridge,
  townLocations,
  townCoverTransform,
} from "./town-game.bridge";
export type TownRendererStatus =
  { kind: "loading"; progress: number } | { kind: "ready" | "fallback" };

/** Imported only by the Angular host after mount. The scene never owns economic state. */
export function startTownGame(
  parent: HTMLElement,
  bridge: TownGameBridge,
  report: (status: TownRendererStatus) => void,
): { destroy: () => void } {
  class PreloadScene extends Phaser.Scene {
    constructor() {
      super("preload");
    }
    preload(): void {
      report({ kind: "loading", progress: 0 });
      this.load.on(Phaser.Loader.Events.PROGRESS, (progress: number) =>
        report({ kind: "loading", progress }),
      );
      this.load.image("town-square", "art/living-town/game/town-square.webp");
    }
    create(): void {
      this.scene.start("town");
    }
  }
  class TownScene extends Phaser.Scene {
    constructor() {
      super("town");
    }
    create(): void {
      const hasArt = this.textures.exists("town-square");
      const world = this.add.container(0, 0);
      if (hasArt)
        world.add(
          this.add.image(640, 360, "town-square").setDisplaySize(1280, 720),
        );
      else world.add(this.add.rectangle(640, 360, 1280, 720, 0x344b35));
      const stops = townLocations
        .filter((location) => ["rex", "luna", "bolt"].includes(location.id))
        .map((location) => {
          const frame = this.add
            .rectangle(
              location.x,
              location.y,
              location.width,
              location.height,
              0xf6d59a,
              0,
            )
            .setStrokeStyle(2, 0xe9c789, 0)
            .setInteractive({ useHandCursor: true });
          world.add(frame);
          frame.on("pointerover", () => frame.setFillStyle(0xf6d59a, 0.08));
          frame.on("pointerout", () => frame.setFillStyle(0xf6d59a, 0));
          frame.on("pointerup", () => bridge.choose(location.id));
          return { location, frame };
        });
      const unsubscribe = bridge.subscribe((snapshot) => {
        for (const { location, frame } of stops) {
          frame.setStrokeStyle(
            2,
            snapshot.selected === location.id ? 0xffe2a1 : 0xe9c789,
            snapshot.selected === location.id ? 0.8 : 0,
          );
          if (snapshot.blocked) frame.disableInteractive();
          else frame.setInteractive({ useHandCursor: true });
        }
      });
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, unsubscribe);
      const fit = () => {
        const transform = townCoverTransform(
          this.scale.width,
          this.scale.height,
        );
        world.setPosition(transform.x, transform.y).setScale(transform.scale);
      };
      fit();
      this.scale.on(Phaser.Scale.Events.RESIZE, fit);
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () =>
        this.scale.off(Phaser.Scale.Events.RESIZE, fit),
      );
      report({ kind: hasArt ? "ready" : "fallback" });
    }
  }
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: parent.clientWidth || 1280,
    height: parent.clientHeight || 720,
    backgroundColor: "#223329",
    banner: false,
    audio: { noAudio: true },
    input: { keyboard: false },
    fps: { target: 30, limit: 30 },
    scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
    render: { antialias: true },
    scene: [PreloadScene, TownScene],
    callbacks: {
      postBoot: (game) => {
        game.canvas.setAttribute("aria-hidden", "true");
        game.canvas.setAttribute("tabindex", "-1");
      },
    },
  });
  return { destroy: () => game.destroy(true) };
}
