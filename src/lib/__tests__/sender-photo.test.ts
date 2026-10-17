// @vitest-environment jsdom
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  on: false,
  invoke: vi.fn(),
  request: vi.fn(),
  kv: new Map<string, unknown>(),
  kvSet: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => h.on, invoke: h.invoke }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok" }));
vi.mock("@/lib/transport", () => ({ request: h.request }));
vi.mock("@/lib/db", () => ({
  kvGet: async (k: string) => h.kv.get(k) ?? null,
  kvSet: async (k: string, v: unknown) => {
    h.kvSet(k, v);
    h.kv.set(k, v);
  },
}));

import {
  extraPhotoSources,
  indexFromPeople,
  resetPersonPhotoQueue,
  usePersonPhotos,
  useSenderPicture,
} from "@/lib/sender-photo";
import { useMail } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import type { Account } from "@/lib/types";

const gmail = { id: "g1", kind: "gmail", address: "me@gmail.com" } as Account;
const m365 = { id: "m1", kind: "m365", address: "alex@example.org" } as Account;

function setAccounts(accounts: Account[]) {
  useMail.setState({ accounts });
}

const settle = (address: string) => vi.waitFor(() => expect(address in usePersonPhotos.getState().photos).toBe(true));

beforeEach(() => {
  h.invoke.mockReset();
  h.request.mockReset();
  h.kvSet.mockReset();
  h.kv.clear();
  h.on = true;
  extraPhotoSources.length = 0;
  resetPersonPhotoQueue();
  usePersonPhotos.setState({ photos: {} });
  setAccounts([]);
});

describe("indexFromPeople", () => {
  it("skips placeholder photos, lowercases every address, ignores people without a photo", () => {
    const out = indexFromPeople([
      { emailAddresses: [{ value: "Ann@X.com" }, { value: "ann2@x.com" }], photos: [{ url: "https://lh3.googleusercontent.com/a", default: true }, { url: "https://lh3.googleusercontent.com/b" }] },
      { emailAddresses: [{ value: "def@x.com" }], photos: [{ url: "https://lh3.googleusercontent.com/c", default: true }] },
      { emailAddresses: [{ value: "none@x.com" }] },
    ]);
    expect(out).toEqual([
      ["ann@x.com", "https://lh3.googleusercontent.com/b"],
      ["ann2@x.com", "https://lh3.googleusercontent.com/b"],
    ]);
  });
});

describe("lookups", () => {
  it("Google: builds the index from two pages, fetches the hit with no bearer, stores it", async () => {
    setAccounts([gmail]);
    h.request.mockImplementation(async (_m: string, url: string) => {
      if (url.includes("people/me/connections")) {
        return url.includes("pageToken=p2")
          ? { connections: [{ emailAddresses: [{ value: "bob@x.com" }], photos: [{ url: "https://lh3.googleusercontent.com/bob" }] }] }
          : { connections: [], nextPageToken: "p2" };
      }
      return { otherContacts: [] };
    });
    h.invoke.mockResolvedValue("data:image/png;base64,AAA");
    usePersonPhotos.getState().request("Bob@X.com");
    await settle("bob@x.com");
    expect(h.invoke).toHaveBeenCalledWith("fetch_photo", { url: "https://lh3.googleusercontent.com/bob", bearer: null });
    expect(usePersonPhotos.getState().photos["bob@x.com"]).toBe("data:image/png;base64,AAA");
    expect(h.kv.get("person_photo:bob@x.com")).toMatchObject({ photo: "data:image/png;base64,AAA" });
    expect(h.kv.has("google_photo_index:g1")).toBe(true);
  });

  it("Microsoft: a colleague uses the Graph URL with a bearer; an external address does not", async () => {
    setAccounts([m365]);
    h.invoke.mockResolvedValue("data:image/jpeg;base64,BBB");
    usePersonPhotos.getState().request("colleague@example.org");
    usePersonPhotos.getState().request("outsider@other.com");
    await settle("colleague@example.org");
    await settle("outsider@other.com");
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith("fetch_photo", {
      url: "https://graph.microsoft.com/v1.0/users/colleague%40example.org/photos/96x96/$value",
      bearer: "tok",
    });
    expect(usePersonPhotos.getState().photos["outsider@other.com"]).toBeNull();
  });

  it("forbidden stops further directory calls for that account and caches nothing", async () => {
    setAccounts([m365]);
    h.invoke.mockRejectedValue("forbidden");
    usePersonPhotos.getState().request("a@example.org");
    await settle("a@example.org");
    usePersonPhotos.getState().request("b@example.org");
    await settle("b@example.org");
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.kvSet).not.toHaveBeenCalled();
  });

  it("uses a fresh cache entry without any lookup, and looks up again when stale", async () => {
    setAccounts([m365]);
    h.kv.set("person_photo:fresh@example.org", { photo: "data:image/png;base64,F", at: Date.now() - 1000 });
    usePersonPhotos.getState().request("fresh@example.org");
    await settle("fresh@example.org");
    expect(usePersonPhotos.getState().photos["fresh@example.org"]).toBe("data:image/png;base64,F");
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();

    h.kv.set("person_photo:stale@example.org", { photo: null, at: Date.now() - 4 * 24 * 3600_000 });
    h.invoke.mockResolvedValue("data:image/png;base64,S");
    usePersonPhotos.getState().request("stale@example.org");
    await settle("stale@example.org");
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(usePersonPhotos.getState().photos["stale@example.org"]).toBe("data:image/png;base64,S");
  });

  it("ignores a fresh entry made with the Contacts setting off once it is on", async () => {
    setAccounts([m365]);
    useSettings.setState({ macContactsPhotos: true });
    h.kv.set("person_photo:c@example.org", { photo: null, at: Date.now() - 1000, contacts: false });
    extraPhotoSources.push(async () => "data:image/png;base64,C");
    usePersonPhotos.getState().request("c@example.org");
    await settle("c@example.org");
    expect(usePersonPhotos.getState().photos["c@example.org"]).toBe("data:image/png;base64,C");
    expect(h.kv.get("person_photo:c@example.org")).toMatchObject({ contacts: true });
    useSettings.setState({ macContactsPhotos: false });
  });

  it("clears this session's photos when the Contacts setting changes", () => {
    usePersonPhotos.setState({ photos: { "a@x.com": null } });
    useSettings.setState({ macContactsPhotos: true });
    expect(usePersonPhotos.getState().photos).toEqual({});
    useSettings.setState({ macContactsPhotos: false });
  });

  it("does nothing outside Tauri", () => {
    h.on = false;
    setAccounts([m365]);
    usePersonPhotos.getState().request("a@example.org");
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.kvSet).not.toHaveBeenCalled();
    expect(usePersonPhotos.getState().photos).toEqual({});
  });

  it("runs at most 4 lookups at once", async () => {
    setAccounts([m365]);
    let active = 0;
    let peak = 0;
    h.invoke.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return "data:image/png;base64,X";
    });
    const names = ["a", "b", "c", "d", "e", "f"].map((n) => `${n}@example.org`);
    for (const n of names) usePersonPhotos.getState().request(n);
    await vi.waitFor(() => expect(Object.keys(usePersonPhotos.getState().photos)).toHaveLength(6));
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("tries extraPhotoSources first and uses their result", async () => {
    setAccounts([m365]);
    extraPhotoSources.push(async () => "data:image/png;base64,EXTRA");
    usePersonPhotos.getState().request("a@example.org");
    await settle("a@example.org");
    expect(usePersonPhotos.getState().photos["a@example.org"]).toBe("data:image/png;base64,EXTRA");
    expect(h.invoke).not.toHaveBeenCalled();
  });
});

describe("useSenderPicture", () => {
  it("never looks up the user's own address", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setAccounts([m365]);
    const seen: unknown[] = [];
    function Probe({ address }: { address: string }) {
      seen.push(useSenderPicture(address, { junk: false }));
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(createElement(Probe, { address: "Alex@Example.org" }));
    });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(usePersonPhotos.getState().photos).toEqual({});
    await act(async () => {
      root.render(createElement(Probe, { address: "other@example.org" }));
    });
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalled());
    await act(async () => root.unmount());
  });
});
