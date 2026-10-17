import { describe, expect, it } from "vitest";
import { useSettings } from "@/lib/settings";

describe("messageBackground setting", () => {
  it("defaults to theme", () => expect(useSettings.getState().messageBackground).toBe("theme"));
});
