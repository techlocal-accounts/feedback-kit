import {beforeEach, describe, expect, it, vi} from "vitest";
import {captureBeforeComposerOpen, captureFeedbackViewport, ClinicalMaskError, FeedbackCaptureError,
  compressFeedbackImageFile,
  fitFeedbackImage, maskFeedbackClone} from "./index";

beforeEach(() => { document.body.innerHTML = ""; });

describe("private screenshot clone", () => {
  it("masks default private fields and app selectors without changing the live page", () => {
    document.body.innerHTML = `<input value="private"><p data-phi>Patient name</p><span class="secret">Account number</span>
      <button data-feedback-capture-exclude>Feedback</button><p class="public">Visible heading</p>`;
    const clone = document.implementation.createHTMLDocument();
    clone.body.innerHTML = document.body.innerHTML;
    maskFeedbackClone(clone, {maskSelectors: [".secret"]});
    expect((clone.querySelector("input") as HTMLInputElement).value).toBe("");
    expect(clone.querySelector("[data-phi]")?.textContent).toBe("");
    expect(clone.querySelector(".secret")?.textContent).toBe("");
    expect(clone.querySelector("[data-feedback-capture-exclude]")).toBeNull();
    expect(clone.querySelector(".public")?.textContent).toBe("Visible heading");
    expect(document.querySelector(".secret")?.textContent).toBe("Account number");
  });

  it("requires every configured clinical mask in the clone", () => {
    const clone = document.implementation.createHTMLDocument();
    clone.body.innerHTML = `<div data-clinical-content>Patient chart</div>`;
    expect(() => maskFeedbackClone(clone, {clinical: {isClinicalScreen: true,
      requiredMaskSelectors: ["[data-clinical-content]", "[data-visit-header]"]}})).toThrow(ClinicalMaskError);
    maskFeedbackClone(clone, {clinical: {isClinicalScreen: true,
      requiredMaskSelectors: ["[data-clinical-content]"]}});
    expect(clone.querySelector("[data-clinical-content]")?.textContent).toBe("");
  });
});

describe("capture lifecycle", () => {
  it("never starts rasterization when a clinical mask is missing", async () => {
    document.body.innerHTML = `<div data-clinical-content>Patient chart</div>`;
    const renderer = vi.fn();
    await expect(captureFeedbackViewport({renderer, clinical: {isClinicalScreen: true,
      requiredMaskSelectors: ["[data-clinical-content]", "[data-visit-header]"]}}))
      .rejects.toBeInstanceOf(ClinicalMaskError);
    expect(renderer).not.toHaveBeenCalled();
  });

  it("refuses a renderer that skips the mask callback", async () => {
    const renderer = vi.fn(async () => document.createElement("canvas"));
    await expect(captureFeedbackViewport({renderer})).rejects.toBeInstanceOf(FeedbackCaptureError);
  });

  it("masks a clinical wrapper in the renderer clone and returns only a bounded blob", async () => {
    document.body.innerHTML = `<main data-clinical-content>Patient chart</main>`;
    const clone = document.implementation.createHTMLDocument();
    clone.body.innerHTML = document.body.innerHTML;
    const context = {fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn()};
    const contextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
    const blobSpy = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => {
      callback(new Blob(["safe"], {type: "image/jpeg"}));
    });
    const renderer = vi.fn(async (_target: HTMLElement, options?: {onclone?: (doc: Document) => void}) => {
      options?.onclone?.(clone);
      expect(clone.querySelector("[data-clinical-content]")?.textContent).toBe("");
      const canvas = document.createElement("canvas");
      canvas.width = 2_000;
      canvas.height = 1_000;
      return canvas;
    });
    try {
      const result = await captureFeedbackViewport({renderer: renderer as never,
        clinical: {isClinicalScreen: true, requiredMaskSelectors: ["[data-clinical-content]"]}});
      expect(result).toMatchObject({mimeType: "image/jpeg", byteSize: 4, width: 1_280, height: 640});
      expect(document.querySelector("[data-clinical-content]")?.textContent).toBe("Patient chart");
    } finally { contextSpy.mockRestore(); blobSpy.mockRestore(); }
  });

  it("captures before opening the app composer and leaves it closed on failure", async () => {
    const order: string[] = [];
    const image = await captureBeforeComposerOpen(async () => {order.push("capture"); return "image";},
      value => order.push(`open ${value}`));
    expect(image).toBe("image");
    expect(order).toEqual(["capture", "open image"]);
    await expect(captureBeforeComposerOpen(async () => {throw new ClinicalMaskError("No mask");},
      () => order.push("unexpected open"))).rejects.toBeInstanceOf(ClinicalMaskError);
    expect(order).toEqual(["capture", "open image"]);
  });

  it("fits images inside the size cap without upscaling", () => {
    expect(fitFeedbackImage({width: 3_000, height: 1_500})).toEqual({width: 1_280, height: 640});
    expect(fitFeedbackImage({width: 400, height: 300})).toEqual({width: 400, height: 300});
  });

  it("converts the GIF default frame to a private-upload-ready JPEG", async () => {
    const contextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn()} as never);
    const blobSpy = vi.spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation(callback => callback(new Blob(["safe"], {type: "image/jpeg"})));
    const close = vi.fn();
    const decode = vi.fn(async () => ({width: 600, height: 300, close}));
    Object.defineProperty(window, "createImageBitmap", {configurable: true, value: decode});
    try {
      const output = await compressFeedbackImageFile(new File(["GIF89a"], "evidence.gif", {type: "image/gif"}));
      expect(decode).toHaveBeenCalledOnce();
      expect(output).toMatchObject({mimeType: "image/jpeg", width: 600, height: 300, byteSize: 4});
      expect(close).toHaveBeenCalledOnce();
    } finally {
      contextSpy.mockRestore(); blobSpy.mockRestore();
      Reflect.deleteProperty(window, "createImageBitmap");
    }
  });
});
