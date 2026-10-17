// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ on: true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => h.on, invoke: h.invoke }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok" }));
vi.mock("@/lib/transport", () => ({ request: vi.fn() }));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));

import { enableMacContacts, macContactPhoto, macContactsStatus } from "@/lib/mac-contacts";
import { extraPhotoSources } from "@/lib/sender-photo";
import { useSettings } from "@/lib/settings";

beforeEach(() => {
  h.on = true;
  h.invoke.mockReset();
  useSettings.setState({ macContactsPhotos: false });
});

describe("mac contacts", () => {
  it("is unavailable outside Tauri", async () => {
    h.on = false;
    useSettings.setState({ macContactsPhotos: true });
    expect(await macContactsStatus()).toBe("unavailable");
    expect(await macContactPhoto("a@b.com")).toBeNull();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("does nothing while the setting is off", async () => {
    expect(await macContactPhoto("a@b.com")).toBeNull();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("returns the photo when on, and null on failure", async () => {
    useSettings.setState({ macContactsPhotos: true });
    h.invoke.mockResolvedValueOnce("data:image/png;base64,AA");
    expect(await macContactPhoto("a@b.com")).toBe("data:image/png;base64,AA");
    expect(h.invoke).toHaveBeenCalledWith("mac_contact_photo", { address: "a@b.com" });
    h.invoke.mockRejectedValueOnce(new Error("boom"));
    expect(await macContactPhoto("a@b.com")).toBeNull();
  });

  it("asks for access only when undecided", async () => {
    h.invoke.mockResolvedValueOnce("notDetermined").mockResolvedValueOnce(true);
    expect(await enableMacContacts()).toBe("granted");
    expect(h.invoke).toHaveBeenLastCalledWith("mac_contacts_request");

    h.invoke.mockReset();
    h.invoke.mockResolvedValueOnce("notDetermined").mockResolvedValueOnce(false);
    expect(await enableMacContacts()).toBe("denied");

    h.invoke.mockReset();
    h.invoke.mockResolvedValueOnce("authorized");
    expect(await enableMacContacts()).toBe("granted");
    expect(h.invoke).toHaveBeenCalledTimes(1);

    h.invoke.mockReset();
    h.invoke.mockResolvedValueOnce("unavailable");
    expect(await enableMacContacts()).toBe("unavailable");
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it("is the first person-photo source", () => {
    expect(extraPhotoSources[0]).toBe(macContactPhoto);
  });
});
