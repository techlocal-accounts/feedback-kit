import {describe, expect, it, vi} from "vitest";
import {handleFeedbackImagePaste} from "./index";

function paste(files: File[], items = files.map(file => ({kind: "file", type: file.type,
  getAsFile: (): File | null => file}))) {
  return {clipboardData: {items, files}, preventDefault: vi.fn()};
}

describe("feedback clipboard paste", () => {
  it("leaves ordinary text and HTML paste untouched", () => {
    const event = paste([], [{kind: "string", type: "text/plain", getAsFile: () => null}]);
    const accept = vi.fn();
    expect(handleFeedbackImagePaste(event, accept)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });

  it("extracts screenshots once when both clipboard representations contain them", () => {
    const image = new File(["png"], "screenshot.png", {type: "image/png"});
    const event = paste([image]);
    const accept = vi.fn();
    expect(handleFeedbackImagePaste(event, accept)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledExactlyOnceWith([image]);
  });

  it("falls back to files, ignores non-images and tolerates unavailable item files", () => {
    const image = new File(["png"], "screenshot.png", {type: "image/png"});
    const text = new File(["text"], "notes.txt", {type: "text/plain"});
    const event = paste([text, image], [{kind: "file", type: "image/png", getAsFile: () => null}]);
    const accept = vi.fn();
    expect(handleFeedbackImagePaste(event, accept)).toBe(true);
    expect(accept).toHaveBeenCalledWith([image]);
  });

  it("supports repeated deliberate pastes and each app controls removal and capacity", () => {
    const image = new File(["png"], "screenshot.png", {type: "image/png"});
    const attachments: File[] = [];
    const accept = (files: File[]) => attachments.push(...files);
    handleFeedbackImagePaste(paste([image]), accept);
    handleFeedbackImagePaste(paste([image]), accept);
    expect(attachments).toEqual([image, image]);
    attachments.splice(0, 1);
    expect(attachments).toEqual([image]);
    attachments.splice(0);
    expect(attachments).toEqual([]);
  });

  it("does nothing without clipboard data or for an empty clipboard", () => {
    const accept = vi.fn();
    expect(handleFeedbackImagePaste({clipboardData: null, preventDefault: vi.fn()}, accept)).toBe(false);
    expect(handleFeedbackImagePaste(paste([]), accept)).toBe(false);
    expect(accept).not.toHaveBeenCalled();
  });
});
