// 测试用 obsidian 最小 stub：vitest 通过 resolve.alias 把 "obsidian" 指向本文件。
// obsidian npm 包仅有类型（main 为空），Node 环境下无法直接解析。
//
// 与真实 API 一致：addText/addButton 会**立即调用**传入的回调（真实 Obsidian 也是这个语义），
// 于是回退式设置面板（display()）在测试里能被真正驱动起来。

/**
 * 供测试驱动回退式设置面板（`display()`）用：addText / addButton 收到的回调按创建顺序记录在此。
 */
export const mockTextOnChange: Array<(value: string) => unknown> = [];
export const mockButtonOnClick: Array<() => unknown> = [];

export function resetMockSettingHandlers(): void {
  mockTextOnChange.length = 0;
  mockButtonOnClick.length = 0;
}

type TextStub = {
  setValue(value: string): TextStub;
  onChange(cb: (value: string) => unknown): TextStub;
};

type ButtonStub = {
  setButtonText(text: string): ButtonStub;
  setCta(): ButtonStub;
  onClick(cb: () => unknown): ButtonStub;
};

export class PluginSettingTab {
  containerEl: { empty: () => void };
  constructor(public app: unknown, public plugin: unknown) {
    this.containerEl = { empty: () => {} };
  }
  /** 与真实 SettingTab 一致：hide() 由框架实现（测试里只记调用次数）。 */
  hide(): void {
    this.hidden += 1;
  }
  hidden = 0;
}

/** 通知 stub：只吞掉调用（测试不校验 Notice 文案）。 */
export class Notice {
  constructor(_message?: string, _timeout?: number) {}
}

/**
 * 文件/目录替身：`ui/imagePicker.ts` 用 `TFile` 作 FuzzySuggestModal 的泛型参数，
 * 并在 `instanceof` 之外的路径上只读 `path`。真实 API 由 Obsidian 提供，这里是类型占位。
 */
export class TFile {
  path = "";
  name = "";
  extension = "";
}

export class TFolder {
  path = "";
}

/** Modal stub：只记录 open/close（真实实现负责 DOM 与遮罩）。 */
export class Modal {
  constructor(public app: unknown) {}
  open(): void {
    this.opened += 1;
  }
  close(): void {
    this.closed += 1;
  }
  opened = 0;
  closed = 0;
}

/**
 * FuzzySuggestModal stub：提供子类会覆盖的那几个钩子与 setPlaceholder。
 * 不驱动 UI——选择流程由 `ui/imagePicker.ts` 的调用方在真机上验证。
 */
export class FuzzySuggestModal<T> extends Modal {
  private placeholder = "";
  setPlaceholder(text: string): void {
    this.placeholder = text;
  }
  getPlaceholder(): string {
    return this.placeholder;
  }
  getItems(): T[] {
    return [];
  }
  getItemText(_item: T): string {
    return "";
  }
  onChooseItem(_item: T): void {}
}

export class Setting {
  constructor(_el: unknown) {}
  setName(_n: string) {
    return this;
  }
  setDesc(_d: string) {
    return this;
  }
  addText(cb?: (text: TextStub) => unknown): TextStub {
    const t: TextStub = {
      setValue: () => t,
      onChange: (handler) => {
        mockTextOnChange.push(handler);
        return t;
      },
    };
    cb?.(t);
    return t;
  }
  addButton(cb?: (button: ButtonStub) => unknown): ButtonStub {
    const b: ButtonStub = {
      setButtonText: () => b,
      setCta: () => b,
      onClick: (handler) => {
        mockButtonOnClick.push(handler);
        return b;
      },
    };
    cb?.(b);
    return b;
  }
}
