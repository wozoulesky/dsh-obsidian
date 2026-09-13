/**
 * 图片附件（TASK-030 项 3）：路径→mediaType 映射、`imageLimits` 准入校验、base64 编码与
 * `session/prompt` 内容块构造。全部是纯函数，便于在无 DOM 的测试环境里直接驱动。
 *
 * 两条硬约束（SPEC《约束》第 5 条 + 本任务交代）：
 * 1. **vault 内文件只能用 vault API 读**——本模块只接受已经读到的字节，不碰文件系统；
 *    真正的读取发生在 `ui/imagePicker.ts`（`vault.readBinary`）。
 * 2. **超大图要提示而不是硬发**：发送前按 `imageLimits` 投影校验字节数/张数，
 *    并被 `maxMessageImageBytes` 的 base64 膨胀（≈4/3）挡在请求体上限之前。
 */
import type { CommandSubmitAttachment, ImageAttachmentLimits, ImageMediaType, PromptContentPart } from "../transport/types";

/** vault 内可发送的图片扩展名 → 线上 mediaType（与 `PromptContentPart.image` 的联合一致）。 */
const EXTENSION_MEDIA_TYPES: Record<string, ImageMediaType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** 取路径对应（小写）扩展名；无扩展名 → 空串。 */
export function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
}

/** 路径是否为插件可发送的图片（扩展名判定，不读文件内容）。 */
export function isImagePath(path: string): boolean {
  return EXTENSION_MEDIA_TYPES[extensionOf(path)] !== undefined;
}

/** 路径对应的线上 mediaType；非图片扩展名 → undefined。 */
export function mediaTypeForPath(path: string): ImageMediaType | undefined {
  return EXTENSION_MEDIA_TYPES[extensionOf(path)];
}

/**
 * `imageLimits` 投影缺失时的保守默认上限。
 *
 * 真机实测（DSH 0.1.5-rc.1 默认部署）：`maxImageBytes=20MiB`、`maxImagesPerMessage=20`、
 * `maxMessageImageBytes=200MiB`、`maxImagePixels=64M`、`maxImageDimension=8192`。
 * 这里在**总字节**上刻意比服务端更保守（20MiB 而非 200MiB）：投影缺失通常意味着
 * "还没收到帧"（冷会话/旧版 DSH），此时宁可提示用户分次发送，也不要把一个
 * base64 膨胀后可能撞上请求体上限的 payload 硬塞出去。
 */
export const FALLBACK_IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 20 * 1024 * 1024,
  maxImagePixels: 64_000_000,
  maxImageDimension: 8192,
  mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
};

/** 一张待发送（已读入内存）的图片。 */
export interface ReadyImage {
  /** vault 内路径（展示与 `name` 字段用）。 */
  path: string;
  mediaType: ImageMediaType;
  /** base64（不含 data URL 前缀）。 */
  data: string;
  /** 原始字节数（准入校验用；base64 长度反推不可靠，故显式携带）。 */
  byteLength: number;
}

/** 拒绝原因（UI 据此选 i18n 文案）。 */
export type ImageRejection = "unsupportedType" | "tooMany" | "tooLarge" | "totalTooLarge";

/** 已就绪图片的准入摘要（校验只看这两个字段）。 */
export interface ImageSize {
  mediaType: ImageMediaType;
  byteLength: number;
}

/**
 * 校验「再追加一张图片」是否被 `imageLimits` 接受；返回 null 表示可以发送。
 *
 * 检查顺序：媒体类型 → 张数 → 单张字节 → 单条消息总字节。
 * 不检查 `maxImagePixels`/`maxImageDimension`：那需要解码图片（渲染进程没有解码器可用），
 * 服务端与采集层（sharp）会做这道校验并以 `session/attachment-invalid` 回报。
 */
export function validateImage(
  existing: readonly ImageSize[],
  candidate: ImageSize,
  limits: ImageAttachmentLimits
): ImageRejection | null {
  if (!limits.mediaTypes.some((mediaType) => mediaType === candidate.mediaType)) return "unsupportedType";
  if (existing.length + 1 > limits.maxImagesPerMessage) return "tooMany";
  if (candidate.byteLength > limits.maxImageBytes) return "tooLarge";
  const total = existing.reduce((sum, image) => sum + image.byteLength, candidate.byteLength);
  if (total > limits.maxMessageImageBytes) return "totalTooLarge";
  return null;
}

/** 原始字节 → base64（不含 data URL 前缀；线上 `data` 字段就是这个形态）。 */
export function encodeBase64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * 已选图片 → `commands/execute` 的 `submittedAttachments`（形状与 `PromptContentPart.image` 一致）。
 *
 * 真机实测：`/goal` 与 `/plan` 的 `input.attachments === true`，其余命令为 false；
 * 不接受附件的命令由 host 返回 `{kind:"error",text:"/x does not accept attachments"}`，
 * 插件照常提示失败——不在这里猜哪些命令收附件。
 */
export function toCommandAttachments(images: readonly ReadyImage[]): CommandSubmitAttachment[] {
  return images.map((image) => ({ type: "image", mediaType: image.mediaType, data: image.data, name: image.path }));
}

/** 人类可读的字节数（提示文案用）：1023 B / 1.5 KB / 20 MB（二进制单位，最多一位小数）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units: Array<{ unit: string; scale: number }> = [
    { unit: "MB", scale: 1024 * 1024 },
    { unit: "KB", scale: 1024 },
    { unit: "B", scale: 1 },
  ];
  for (const { unit, scale } of units) {
    if (bytes >= scale || scale === 1) {
      const value = bytes / scale;
      const rounded = Math.round(value * 10) / 10;
      return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)} ${unit}`;
    }
  }
  return `${bytes} B`;
}

/**
 * 构造 `session/prompt` 的 content：
 * - 纯空白文本不产生 text 块（否则等于给模型塞一条空消息）；
 * - 图片按选中顺序排在文本之后（与官方 composer 的"文本 + 附件"顺序一致）。
 *
 * 调用方需保证「text 非空」或「images 非空」——线上要求至少一个非空白 text 块或附件。
 */
export function buildPromptContent(text: string, images: readonly ReadyImage[]): PromptContentPart[] {
  const parts: PromptContentPart[] = [];
  if (text.trim().length > 0) parts.push({ type: "text", text });
  for (const image of images) {
    parts.push({ type: "image", mediaType: image.mediaType, data: image.data, name: image.path });
  }
  return parts;
}
