import { describe, expect, it } from "vitest";
import { webPublicPrefix } from "./web-public-prefix";

describe("webPublicPrefix", () => {
  it("stays empty on the relay root and the desktop", () => {
    expect(webPublicPrefix("/")).toBe("");
    expect(webPublicPrefix("/_relay")).toBe("");
    expect(webPublicPrefix("/assets/app.js")).toBe("");
  });

  it("follows the Arashi /CCGUI mount", () => {
    expect(webPublicPrefix("/CCGUI")).toBe("/CCGUI");
    expect(webPublicPrefix("/CCGUI/")).toBe("/CCGUI");
    expect(webPublicPrefix("/CCGUI/assets/app.js")).toBe("/CCGUI");
  });
});
