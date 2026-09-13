/**
 * TASK-030 项 3：图片附件纯函数层单测（`src/ui/imageAttach.ts`）。
 *
 * 上限样本取自真机 `imageLimits` 投影：20MiB / 20 张 / 200MiB / 64M px / 8192px / 四种 mediaType。
 * 覆盖：扩展名→mediaType、四类拒绝原因、base64 编码、字节格式化、content 组装。
 */
import { describe, expect, it } from "vitest";
import {
  FALLBACK_IMAGE_LIMITS,
  buildPromptContent,
  encodeBase64,
  extensionOf,
  formatBytes,
  isImagePath,
  mediaTypeForPath,
  toCommandAttachments,
  validateImage,
  type ReadyImage,
} from "../../src/ui/imageAttach";
import type { ImageAttachmentLimits } from "../../src/transport/types";

/** 真机 imageLimits 投影（逐字）。 */
const REAL_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 20971520,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 209715200,
  maxImagePixels: 64000000,
  maxImageDimension: 8192,
  mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
};

function image(path: string, byteLength: number): ReadyImage {
  const mediaType = mediaTypeForPath(path);
  if (!mediaType) throw new Error(`测试夹具不是图片：${path}`);
  return { path, mediaType, data: "AAAA", byteLength };
}

describe("extensionOf / isImagePath / mediaTypeForPath", () => {
  it("识别四种可发送格式（大小写与多级目录）", () => {
    expect(mediaTypeForPath("a/b/图.PNG")).toBe("image/png");
    expect(mediaTypeForPath("shot.jpeg")).toBe("image/jpeg");
    expect(mediaTypeForPath("x.JPG")).toBe("image/jpeg");
    expect(mediaTypeForPath("anim.webp")).toBe("image/webp");
    expect(mediaTypeForPath("meme.gif")).toBe("image/gif");
  });

  it("非图片与无扩展名一律拒绝", () => {
    for (const path of ["note.md", "a/b", "archive.zip", "photo.tiff", "noext", "trailing."]) {
      expect(isImagePath(path)).toBe(false);
      expect(mediaTypeForPath(path)).toBeUndefined();
    }
    expect(extensionOf("a.b/c.PNG")).toBe("png");
    expect(extensionOf("noext")).toBe("");
  });
});

describe("validateImage（真机 imageLimits）", () => {
  it("首张合法图片通过", () => {
    expect(validateImage([], { mediaType: "image/png", byteLength: 1024 }, REAL_LIMITS)).toBeNull();
  });

  it("媒体类型不在部署允许集合内 → unsupportedType", () => {
    expect(validateImage([], { mediaType: "image/gif", byteLength: 1 }, { ...REAL_LIMITS, mediaTypes: ["image/png"] })).toBe("unsupportedType");
    expect(validateImage([], { mediaType: "image/png", byteLength: 1 }, { ...REAL_LIMITS, mediaTypes: [] })).toBe("unsupportedType");
  });

  it("超出张数上限 → tooMany（含边界：恰好等于上限通过）", () => {
    const limits = { ...REAL_LIMITS, maxImagesPerMessage: 2 };
    const one = [{ mediaType: "image/png" as const, byteLength: 10 }];
    expect(validateImage(one, { mediaType: "image/png", byteLength: 10 }, limits)).toBeNull();
    expect(validateImage([...one, ...one], { mediaType: "image/png", byteLength: 10 }, limits)).toBe("tooMany");
  });

  it("单张超上限 → tooLarge（边界：恰好等于上限通过）", () => {
    const limits = { ...REAL_LIMITS, maxImageBytes: 100 };
    expect(validateImage([], { mediaType: "image/png", byteLength: 100 }, limits)).toBeNull();
    expect(validateImage([], { mediaType: "image/png", byteLength: 101 }, limits)).toBe("tooLarge");
  });

  it("累计超单条消息上限 → totalTooLarge（逐张累加，不是只看单张）", () => {
    const limits = { ...REAL_LIMITS, maxImageBytes: 1000, maxMessageImageBytes: 150 };
    expect(validateImage([{ mediaType: "image/png", byteLength: 100 }], { mediaType: "image/png", byteLength: 50 }, limits)).toBeNull();
    expect(validateImage([{ mediaType: "image/png", byteLength: 100 }], { mediaType: "image/png", byteLength: 51 }, limits)).toBe("totalTooLarge");
  });

  it("拒绝原因优先级：类型 → 张数 → 单张 → 总量", () => {
    const limits: ImageAttachmentLimits = { ...REAL_LIMITS, mediaTypes: ["image/png"], maxImagesPerMessage: 2, maxImageBytes: 10, maxMessageImageBytes: 5 };
    expect(validateImage([], { mediaType: "image/gif", byteLength: 999 }, limits)).toBe("unsupportedType"); // 类型最先
    expect(validateImage([{ mediaType: "image/png", byteLength: 4 }, { mediaType: "image/png", byteLength: 4 }], { mediaType: "image/png", byteLength: 2 }, limits)).toBe("tooMany");
    expect(validateImage([], { mediaType: "image/png", byteLength: 11 }, limits)).toBe("tooLarge");
    expect(validateImage([{ mediaType: "image/png", byteLength: 4 }], { mediaType: "image/png", byteLength: 2 }, limits)).toBe("totalTooLarge");
  });

  it("FALLBACK 默认上限比服务端总量更保守（投影缺失时不硬发大 payload）", () => {
    expect(FALLBACK_IMAGE_LIMITS.maxMessageImageBytes).toBeLessThanOrEqual(REAL_LIMITS.maxImageBytes);
    expect(FALLBACK_IMAGE_LIMITS.maxImageBytes).toBe(REAL_LIMITS.maxImageBytes);
    expect(FALLBACK_IMAGE_LIMITS.mediaTypes).toEqual(REAL_LIMITS.mediaTypes);
  });
});

describe("encodeBase64", () => {
  it("按原始字节编码（不含 data URL 前缀）", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    expect(encodeBase64(bytes)).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
    expect(encodeBase64(bytes)).not.toContain("data:");
  });

  it("空输入 → 空串（不是 undefined）", () => {
    expect(encodeBase64(new ArrayBuffer(0))).toBe("");
  });
});

describe("formatBytes", () => {
  it("按 B/KB/MB 分段并最多保留一位小数", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
    expect(formatBytes(209715200)).toBe("200 MB");
  });

  it("非法输入不抛错", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});

describe("buildPromptContent", () => {  it("文本在前、图片在后（图片带 vault 路径作为 name）", () => {
    const parts = buildPromptContent("看图", [image("notes/a.png", 10)]);
    expect(parts).toEqual([
      { type: "text", text: "看图" },
      { type: "image", mediaType: "image/png", data: "AAAA", name: "notes/a.png" },
    ]);
  });

  it("纯空白文本不产生 text 块（避免空消息）", () => {
    expect(buildPromptContent("   \n ", [])).toEqual([]);
    expect(buildPromptContent("", [image("a.jpg", 1)])).toEqual([{ type: "image", mediaType: "image/jpeg", data: "AAAA", name: "a.jpg" }]);
  });

  it("文本原样保留（不做 trim：换行与缩进是内容的一部分）", () => {
    const parts = buildPromptContent("  保留缩进  ", []);
    expect(parts).toEqual([{ type: "text", text: "  保留缩进  " }]);
  });

  it("多张图片按选中顺序排列", () => {
    const parts = buildPromptContent("x", [image("a.png", 1), image("b.webp", 2)]);
    expect(parts.map((p) => (p.type === "image" ? p.name : p.type))).toEqual(["text", "a.png", "b.webp"]);
  });
});

describe("toCommandAttachments（命令附件，TASK-030 项 2/3）", () => {
  it("形状与 PromptContentPart.image 一致（type/mediaType/data/name）", () => {
    expect(toCommandAttachments([image("notes/a.png", 4)])).toEqual([{ type: "image", mediaType: "image/png", data: "AAAA", name: "notes/a.png" }]);
  });

  it("无图片 → 空数组（commands/execute 要求该键存在且为数组）", () => {
    expect(toCommandAttachments([])).toEqual([]);
  });

  it("顺序与选中顺序一致", () => {
    expect(toCommandAttachments([image("a.png", 1), image("b.jpg", 2)]).map((a) => (a.type === "image" ? a.name : a.receiptId))).toEqual(["a.png", "b.jpg"]);
  });
});
