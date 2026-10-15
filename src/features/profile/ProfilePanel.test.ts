import { describe, expect, it } from "vitest";
import { profileReaderUrl } from "./ProfilePanel";

describe("profileReaderUrl", () => {
  it("follows the Arashi /CCGUI mount", () => {
    expect(profileReaderUrl("/CCGUI/", "PC5")).toBe("/CCGUI/profile/PC5/");
    expect(profileReaderUrl("/CCGUI/chat/x", "MC2")).toBe("/CCGUI/profile/MC2/");
  });

  it("uses the relay root when not mounted", () => {
    expect(profileReaderUrl("/", "PC0")).toBe("/profile/PC0/");
  });

  it("encodes the machine name as one path segment", () => {
    expect(profileReaderUrl("/CCGUI", "a/b c")).toBe("/CCGUI/profile/a%2Fb%20c/");
  });
});
