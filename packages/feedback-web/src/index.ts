import { MAX_IMAGE_BYTES } from "@techlocal/feedback-core/limits";

export const DEFAULT_PRIVATE_SELECTORS = [
  "input", "textarea", "select", "[contenteditable]", "[data-feedback-private]",
  "[data-private]", "[data-sensitive]", "[data-phi]", "[data-pii]", "iframe", "video", "canvas",
] as const;
export const MAX_SOURCE_IMAGE_BYTES = 12_000_000;

export class ClinicalMaskError extends Error {}
export class FeedbackCaptureError extends Error {}

export type CapturedFeedbackImage = {
  blob: Blob;
  fileName: string;
  mimeType: "image/jpeg";
  byteSize: number;
  width: number;
  height: number;
};
export type CaptureOptions = {
  window?: Window;
  document?: Document;
  maskSelectors?: readonly string[];
  /** App routes with clinical content must supply at least one matching selector per item. */
  clinical?: {isClinicalScreen: boolean; requiredMaskSelectors: readonly string[]};
  /** A stable app-owned selector for capture UI that should not appear in the image. */
  excludeSelectors?: readonly string[];
  /** App-specific clone cleanup runs after the shared private masks. */
  prepareClone?: (clone: Document) => void;
  filePrefix?: string;
  /** Dependency injection for deterministic integration tests. */
  renderer?: Html2Canvas;
};
type Html2Canvas = typeof import("html2canvas-pro").default;
type Html2CanvasOptions = NonNullable<Parameters<Html2Canvas>[1]>;

function checkedElements(doc: Document, selector: string): NodeListOf<Element> {
  try { return doc.querySelectorAll(selector); }
  catch { throw new FeedbackCaptureError(`Invalid screenshot mask selector: ${selector}`); }
}

function verifyClinicalMasks(doc: Document, clinical: CaptureOptions["clinical"]) {
  if (!clinical?.isClinicalScreen) return;
  if (!clinical.requiredMaskSelectors.length) throw new ClinicalMaskError("Clinical capture requires configured masks");
  for (const selector of clinical.requiredMaskSelectors) {
    if (!checkedElements(doc, selector).length) throw new ClinicalMaskError(`Clinical mask did not match: ${selector}`);
  }
}

function hideElement(element: Element) {
  const html = element as HTMLElement;
  if (element instanceof HTMLInputElement) element.value = "";
  if (element instanceof HTMLTextAreaElement) element.value = "";
  if (element instanceof HTMLSelectElement) element.selectedIndex = -1;
  html.replaceChildren();
  html.removeAttribute("placeholder");
  html.removeAttribute("value");
  html.setAttribute("aria-label", "Private content hidden");
  html.style.setProperty("visibility", "hidden", "important");
}

/** Runs on the detached html2canvas clone; the live app DOM is untouched. */
export function maskFeedbackClone(doc: Document, options: Pick<CaptureOptions, "maskSelectors" | "clinical" | "excludeSelectors"> = {}): void {
  verifyClinicalMasks(doc, options.clinical);
  for (const selector of [...DEFAULT_PRIVATE_SELECTORS, ...(options.maskSelectors ?? []),
    ...(options.clinical?.isClinicalScreen ? options.clinical.requiredMaskSelectors : [])]) {
    for (const element of checkedElements(doc, selector)) hideElement(element);
  }
  for (const selector of ["[data-feedback-capture-exclude]", ...(options.excludeSelectors ?? [])]) {
    for (const element of checkedElements(doc, selector)) element.remove();
  }
  const style = doc.createElement("style");
  style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
  doc.head.append(style);
}

export function fitFeedbackImage(size: {width: number; height: number}, maximum = 1_280) {
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  const scale = Math.min(1, maximum / Math.max(width, height));
  return {width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale))};
}

function resizeCanvas(source: CanvasImageSource, size: {width: number; height: number}, doc: Document): HTMLCanvasElement {
  const canvas = doc.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d", {alpha: false});
  if (!ctx) throw new FeedbackCaptureError("Canvas is unavailable");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(source, 0, 0, size.width, size.height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new FeedbackCaptureError("Screenshot could not be encoded")), "image/jpeg", quality));
}

export async function compressFeedbackCanvas(source: HTMLCanvasElement, doc: Document, filePrefix = "feedback"): Promise<CapturedFeedbackImage> {
  let canvas = resizeCanvas(source, fitFeedbackImage({width: source.width, height: source.height}), doc);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    for (const quality of [0.8, 0.7, 0.6, 0.5]) {
      const blob = await toBlob(canvas, quality);
      if (blob.size <= MAX_IMAGE_BYTES) {
        return {blob, fileName: `${filePrefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`,
          mimeType: "image/jpeg", byteSize: blob.size, width: canvas.width, height: canvas.height};
      }
    }
    canvas = resizeCanvas(canvas, fitFeedbackImage({width: canvas.width, height: canvas.height},
      Math.round(Math.max(canvas.width, canvas.height) * 0.78)), doc);
  }
  throw new FeedbackCaptureError("Screenshot is too large after compression");
}

export async function compressFeedbackImageFile(file: File, doc: Document = document): Promise<CapturedFeedbackImage> {
  if (file.size > MAX_SOURCE_IMAGE_BYTES) throw new FeedbackCaptureError("Image is too large to prepare");
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) throw new FeedbackCaptureError("Unsupported image type");
  if (file.type === "image/gif") {
    const view = doc.defaultView;
    if (!view?.createImageBitmap) throw new FeedbackCaptureError("This browser cannot prepare a GIF attachment");
    // The HTML Standard selects the GIF default image, or its first frame.
    const bitmap = await view.createImageBitmap(file);
    try {
      const canvas = resizeCanvas(bitmap, fitFeedbackImage({width: bitmap.width, height: bitmap.height}), doc);
      return compressFeedbackCanvas(canvas, doc, "feedback-attachment");
    } finally { bitmap.close(); }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = doc.createElement("img");
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new FeedbackCaptureError("Image could not be opened"));
      image.src = url;
    });
    const canvas = resizeCanvas(image, fitFeedbackImage({width: image.naturalWidth, height: image.naturalHeight}), doc);
    return compressFeedbackCanvas(canvas, doc, "feedback-attachment");
  } finally { URL.revokeObjectURL(url); }
}

function viewportDimension(value: number) { return Number.isFinite(value) ? Math.min(8_192, Math.max(1, Math.round(value))) : 1; }

/** Capture the live viewport with masks applied in html2canvas's clone. */
export async function captureFeedbackViewport(options: CaptureOptions = {}): Promise<CapturedFeedbackImage> {
  const win = options.window ?? window;
  const doc = options.document ?? document;
  verifyClinicalMasks(doc, options.clinical);
  // Check all selectors before rendering so malformed app config cannot produce an unmasked image.
  for (const selector of [...(options.maskSelectors ?? []), ...(options.excludeSelectors ?? [])]) checkedElements(doc, selector);
  const renderer = options.renderer ?? (await import("html2canvas-pro")).default;
  let cloneMasked = false;
  const renderOptions: Html2CanvasOptions = {
    backgroundColor: null, logging: false, useCORS: true,
    width: viewportDimension(win.innerWidth), height: viewportDimension(win.innerHeight),
    windowWidth: viewportDimension(win.innerWidth), windowHeight: viewportDimension(win.innerHeight),
    scale: Math.min(2, Math.max(1, win.devicePixelRatio || 1)),
    x: Math.max(0, win.scrollX), y: Math.max(0, win.scrollY),
    onclone: clone => {
      maskFeedbackClone(clone, options);
      options.prepareClone?.(clone);
      cloneMasked = true;
    },
  };
  const canvas = await renderer(doc.documentElement, renderOptions);
  if (!cloneMasked) throw new FeedbackCaptureError("Screenshot clone was not masked");
  return compressFeedbackCanvas(canvas, doc, options.filePrefix);
}

/** Await capture before mounting or opening the app-owned composer. Capture failure leaves it closed. */
export async function captureBeforeComposerOpen<T>(capture: () => Promise<T>, openComposer: (image: T) => void): Promise<T> {
  const image = await capture();
  openComposer(image);
  return image;
}
