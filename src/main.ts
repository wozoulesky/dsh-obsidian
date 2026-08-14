import { Plugin } from "obsidian";
import { installNodeShims } from "./transport/nodeShims";
import { DshSettings } from "./settings";

export default class DshPlugin extends Plugin {
  settings = new DshSettings(this);

  async onload(): Promise<void> {
    installNodeShims();
    await this.settings.load();
  }

  onunload(): void {}
}
