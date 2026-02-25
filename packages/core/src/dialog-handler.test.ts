import { describe, it, expect } from "bun:test";
import {
  matchKnownDialog,
  parseDialogResponse,
  looksNormal,
  KNOWN_DIALOGS,
  ClaudeDialogError,
} from "./dialog-handler.js";

describe("matchKnownDialog", () => {
  it("matches bypass permissions dialog", () => {
    const result = matchKnownDialog("Do you want to bypass permissions for this session?");
    expect(result).not.toBeNull();
    expect(result!.keys).toEqual(["Enter"]);
  });

  it("matches trust project dialog", () => {
    const result = matchKnownDialog("Do you trust this project directory?");
    expect(result).not.toBeNull();
    expect(result!.keys).toEqual(["Enter"]);
  });

  it("matches theme selection dialog", () => {
    const result = matchKnownDialog("Choose the text style that looks best on your terminal");
    expect(result).not.toBeNull();
  });

  it("returns null for normal output", () => {
    expect(matchKnownDialog("> ")).toBeNull();
    expect(matchKnownDialog("Thinking...")).toBeNull();
  });
});

describe("looksNormal", () => {
  it("returns true for empty pane", () => {
    expect(looksNormal("")).toBe(true);
    expect(looksNormal("   \n  \n")).toBe(true);
  });

  it("returns true for REPL prompt", () => {
    expect(looksNormal("> ")).toBe(true);
    expect(looksNormal("some output\n> ")).toBe(true);
  });

  it("returns true for spinner characters", () => {
    expect(looksNormal("⠋ Thinking")).toBe(true);
  });

  it("returns false for dialog text", () => {
    expect(looksNormal("Do you want to bypass permissions?")).toBe(false);
  });
});

describe("parseDialogResponse", () => {
  it("parses blocked response with keys", () => {
    const result = parseDialogResponse(
      '{"blocked": true, "keys": ["Down", "Enter"], "reason": "test"}'
    );
    expect(result.blocked).toBe(true);
    expect(result.keys).toEqual(["Down", "Enter"]);
    expect(result.reason).toBe("test");
  });

  it("parses not-blocked response", () => {
    const result = parseDialogResponse('{"blocked": false}');
    expect(result.blocked).toBe(false);
    expect(result.keys).toEqual([]);
  });

  it("filters invalid keys", () => {
    const result = parseDialogResponse(
      '{"blocked": true, "keys": ["Enter", "rm -rf", "Tab"], "reason": "test"}'
    );
    expect(result.keys).toEqual(["Enter", "Tab"]);
  });

  it("enforces max key limit", () => {
    const keys = Array(15).fill("Enter");
    const result = parseDialogResponse(
      JSON.stringify({ blocked: true, keys, reason: "test" })
    );
    expect(result.keys.length).toBe(10);
  });
});

describe("ClaudeDialogError", () => {
  it("includes captured output", () => {
    const err = new ClaudeDialogError("test error", "pane output");
    expect(err.name).toBe("ClaudeDialogError");
    expect(err.capturedOutput).toBe("pane output");
    expect(err.message).toBe("test error");
  });
});
