// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kv = vi.hoisted(() => ({ saved: null as unknown, sets: [] as unknown[] }));
vi.mock("@/lib/db", () => ({ kvGet: async () => kv.saved, kvSet: async (_k: string, v: unknown) => void kv.sets.push(v) }));
const toastMock = vi.hoisted(() => ({ message: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock.message }));
const { clearChat, parseCommand, planSend, submitAction, useAssistant, assistantSnapshot, restoreAssistant, loadAssistant, startAssistantAutosave, listKeyBlocked } = await import("@/lib/ai/assistant/state");

const { findCommand } = await import("@/lib/ai/assistant/commands");

const bulkMock = { undo: vi.fn(async () => ({ done: 0, skipped: 0, failed: [], undo: [] })) };
const { useMail } = await import("@/lib/store");

beforeEach(() => useAssistant.getState().newChat());

describe("assistant refs", () => {
  const e = { id: "x1", accountId: "g", from: { name: "Ann", address: "a@b.c" }, subject: "Hi", date: "2025-10-03T10:00:00Z" } as never;
  it("assigns stable refs and newChat resets them", () => {
    const st = useAssistant.getState();
    expect(st.refFor(e)).toBe("m1");
    expect(st.refFor(e)).toBe("m1");
    expect(useAssistant.getState().refs.m1).toEqual({ id: "x1", accountId: "g", from: "Ann", subject: "Hi", date: "2025-10-03" });
    useAssistant.getState().newChat();
    expect(useAssistant.getState().refs).toEqual({});
    expect(useAssistant.getState().refSeq).toBe(0);
  });
  it("snapshot round-trip keeps refs; old snapshots default", () => {
    useAssistant.getState().refFor(e);
    const snap = assistantSnapshot(useAssistant.getState());
    useAssistant.getState().newChat();
    restoreAssistant(snap);
    expect(useAssistant.getState().refs.m1.id).toBe("x1");
    expect(useAssistant.getState().refSeq).toBe(1);
    restoreAssistant({ items: [], history: [] });
    expect(useAssistant.getState().refs).toEqual({});
    expect(useAssistant.getState().refSeq).toBe(0);
  });
});

describe("assistant state", () => {
  it("adds sets, remembers ids, and queues notes for the next message", () => {
    const st = useAssistant.getState();
    const set = st.addSet({ label: "From amazon.com", refs: [{ id: "a", accountId: "g" }] });
    st.remember([{ id: "a", accountId: "g" }]);
    st.note("The user confirmed the trash.");
    const now = useAssistant.getState();
    expect(now.sets[set.id].refs).toHaveLength(1);
    expect(now.known.a).toEqual({ id: "a", accountId: "g" });
    expect(now.drainNotes()).toEqual(["The user confirmed the trash."]);
    expect(useAssistant.getState().notes).toEqual([]);
  });

  it("patches cards by item id", () => {
    const id = useAssistant.getState().push({ kind: "card", card: { type: "event", event: { title: "Flight", start: "2026-11-02T08:00:00", end: "2026-11-02T09:00:00", allDay: false }, status: "pending" } });
    useAssistant.getState().patchCard(id, { status: "added" });
    const item = useAssistant.getState().items.find((i) => i.id === id);
    expect(item?.kind === "card" && item.card.type !== "draft" && item.card.status).toBe("added");
  });

  it("patchCard on a missing item does nothing", () => {
    useAssistant.getState().newChat();
    expect(() => useAssistant.getState().patchCard("gone", { status: "done" })).not.toThrow();
    expect(useAssistant.getState().items).toEqual([]);
  });

  it("new chat clears the conversation and sets but keeps the panel open", () => {
    const st = useAssistant.getState();
    st.toggle(true);
    st.push({ kind: "user", text: "hi" });
    st.addSet({ label: "x", refs: [] });
    st.newChat();
    const now = useAssistant.getState();
    expect([now.items.length, Object.keys(now.sets).length, now.open]).toEqual([0, 0, true]);
  });

  it("saves the conversation without sets, trimmed to the newest 200 items and 40 messages", () => {
    const st = useAssistant.getState();
    for (let i = 0; i < 230; i++) st.push({ kind: "step", text: `s${i}` });
    for (let i = 0; i < 50; i++) st.pushHistory({ role: "user", content: `m${i}` });
    st.addSet({ label: "x", refs: [] });
    const snap = assistantSnapshot(useAssistant.getState());
    expect(snap.items).toHaveLength(200);
    expect(snap.history).toHaveLength(40);
    expect(snap.history[0]).toEqual({ role: "user", content: "m10" });
    expect(snap).not.toHaveProperty("sets");
  });

  it("running cards load as interrupted, with their emails kept for Resume", () => {
    restoreAssistant({
      items: [{ id: "c", kind: "card", card: { type: "bulk", op: { kind: "trash" }, refs: [{ id: "a", accountId: "g" }], title: "Move 1 to Trash", detail: "", status: "running", done: 0, total: 1 } }],
      history: [],
    });
    const item = useAssistant.getState().items[0];
    expect(item.kind === "card" && item.card.type === "bulk" && item.card.status).toBe("partial");
    expect(item.kind === "card" && item.card.type === "bulk" && item.card.failedRefs).toEqual([{ id: "a", accountId: "g" }]);
  });

  it("drops a saved history that starts with tool results (it can't be replayed)", () => {
    restoreAssistant({ items: [], history: [{ role: "tool", toolCallId: "x", name: "act", content: "{}" }, { role: "user", content: "hi" }] });
    expect(useAssistant.getState().history).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("final fixes: restore, load and autosave", () => {
  const bulk = (over: Record<string, unknown>) =>
    ({ id: "c", kind: "card", card: { type: "bulk", op: { kind: "trash" }, refs: [{ id: "a", accountId: "g" }, { id: "b", accountId: "g" }], title: "Move 2 to Trash", detail: "", status: "done", done: 2, total: 2, ...over } }) as never;
  const card = () => {
    const i = useAssistant.getState().items[0];
    return i.kind === "card" && i.card.type === "bulk" ? i.card : undefined;
  };

  it("restore drops Undo from every card (it's from a previous session)", () => {
    restoreAssistant({ items: [bulk({ undo: [{ id: "a", accountId: "g", folderId: "g:INBOX", unread: false, starred: false }] })], history: [] });
    expect([card()?.undo, card()?.undoExpired, card()?.status]).toEqual([undefined, true, "done"]);
  });

  it("an interrupted first run resumes from zero, not from its progress", () => {
    restoreAssistant({ items: [bulk({ status: "running", done: 1 })], history: [] });
    expect([card()?.status, card()?.done, card()?.failedRefs?.length]).toEqual(["partial", 0, 2]);
  });

  it("an interrupted resume counts only what's outside failedRefs as done", () => {
    restoreAssistant({ items: [bulk({ status: "running", done: 2, failedRefs: [{ id: "b", accountId: "g" }] })], history: [] });
    expect([card()?.done, card()?.failedRefs?.length]).toEqual([1, 1]);
  });

  it("a confirm card cut off while running is restored as failed, so Try again stays available", () => {
    const confirm = (status: string) => ({ id: status, kind: "card", card: { type: "confirm", module: "send", action: "send_reply", title: "Reply to Ann", payload: {}, confirmLabel: "Send", status } }) as never;
    restoreAssistant({ items: [confirm("running"), confirm("pending")], history: [] });
    const [a, b] = useAssistant.getState().items.map((i) => (i.kind === "card" && i.card.type === "confirm" ? i.card : undefined));
    expect([a?.status, a?.error]).toEqual(["failed", "Interrupted when zMail closed. It may have gone through."]);
    expect(b?.status).toBe("pending");
  });

  it("restoring a conversation tells the model its ids are gone", () => {
    restoreAssistant({ items: [], history: [{ role: "user", content: "hi" }] });
    expect(useAssistant.getState().drainNotes()).toEqual(["zMail restarted: earlier sets and email ids are gone; search again before acting."]);
    restoreAssistant({ items: [], history: [] });
    expect(useAssistant.getState().notes).toEqual([]);
  });

  it("a draft card's saved copy has no attachment bytes, and reopens without them, naming the files", () => {
    const compose = { mode: "blank" as const, prefill: { subject: "Hi" }, attachments: [{ filename: "report.pdf", mimeType: "application/pdf", base64: "QUJD".repeat(1000), size: 3000 }] };
    useAssistant.getState().push({ kind: "card", card: { type: "draft", summary: "Opened a new email in compose", compose } });
    const snap = assistantSnapshot(useAssistant.getState());
    expect(JSON.stringify(snap)).not.toContain("base64");
    const saved = snap.items[0];
    expect(saved.kind === "card" && saved.card.type === "draft" && saved.card.compose.attachments).toEqual([{ filename: "report.pdf", mimeType: "application/pdf", size: 3000 }]);
    // The live card still has its files for this session.
    const live = useAssistant.getState().items[0];
    expect(live.kind === "card" && live.card.type === "draft" && live.card.compose.attachments?.[0].base64).toBeTruthy();
    restoreAssistant(JSON.parse(JSON.stringify(snap)));
    const back = useAssistant.getState().items[0];
    expect(back.kind === "card" && back.card.type === "draft" && back.card).toMatchObject({ summary: "Opened a new email in compose · attach again: report.pdf", compose: { mode: "blank", prefill: { subject: "Hi" }, attachments: undefined } });
  });

  it("loading doesn't overwrite a conversation started before it finished", async () => {
    kv.saved = { items: [{ id: "x", kind: "user", text: "old" }], history: [{ role: "user", content: "old" }] };
    useAssistant.getState().push({ kind: "user", text: "new" });
    await loadAssistant();
    expect(useAssistant.getState().items.map((i) => i.kind === "user" && i.text)).toEqual(["new"]);
    useAssistant.getState().newChat();
    await loadAssistant();
    expect(useAssistant.getState().items.map((i) => i.kind === "user" && i.text)).toEqual(["old"]);
    kv.saved = null;
  });

  it("autosave waits for changes to settle but never more than 2s, and flushes on pagehide", async () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const stop = startAssistantAutosave(target as unknown as Window);
    try {
      kv.sets.length = 0;
      // A change every 400ms keeps resetting the 600ms settle timer.
      for (let t = 0; t < 1900; t += 400) {
        useAssistant.getState().push({ kind: "step", text: `s${t}` });
        await vi.advanceTimersByTimeAsync(400);
      }
      expect(kv.sets).toHaveLength(1);
      useAssistant.getState().push({ kind: "step", text: "last" });
      target.dispatchEvent(new Event("pagehide"));
      expect(kv.sets).toHaveLength(2);
      expect((kv.sets[1] as { items: { text: string }[] }).items.at(-1)?.text).toBe("last");
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});

describe("shortcuts in a set view", () => {
  it("⌘A, j/k and arrows do nothing while a set is shown; other keys still work", () => {
    for (const k of ["j", "k", "ArrowDown", "ArrowUp"]) expect(listKeyBlocked(k, false, "set_1")).toBe(true);
    expect(listKeyBlocked("a", true, "set_1")).toBe(true);
    expect(listKeyBlocked("e", false, "set_1")).toBe(false);
    expect(listKeyBlocked("j", true, "set_1")).toBe(false);
    expect(listKeyBlocked("a", true, null)).toBe(false);
    expect(listKeyBlocked("j", false, null)).toBe(false);
  });
});

describe("clearChat and /clear", () => {
  const bulk = (status: "running" | "undoing" | "done") =>
    ({ kind: "card", card: { type: "bulk", op: "trash", refs: [], title: "t", detail: "d", status: status === "undoing" ? "done" : status, undoing: status === "undoing", done: 0, total: 0 } }) as never;

  it("empties items, history, sets and headers, and bumps chatId", async () => {
    const st = useAssistant.getState();
    st.push({ kind: "user", text: "hi" });
    st.pushHistory({ role: "user", content: "hi" } as never);
    st.addSet({ label: "x", refs: [] });
    st.addHeaders([{ id: "a" } as never]);
    const before = useAssistant.getState().chatId;
    await clearChat();
    const now = useAssistant.getState();
    expect(now.items).toEqual([]);
    expect(now.history).toEqual([]);
    expect(now.sets).toEqual({});
    expect(now.headers).toEqual({});
    expect(now.chatId).toBe(before + 1);
  });

  describe("while a bulk card is busy", () => {
    const runningCard = (extra: object = {}) =>
      ({ kind: "card", card: { type: "bulk", op: { kind: "trash" }, refs: [], title: "Move to Trash: 214 emails", detail: "d", status: "running", done: 88, total: 214, ...extra } }) as never;
    beforeEach(() => {
      vi.useFakeTimers();
      toastMock.message.mockClear();
      useMail.setState({ bulkUndo: bulkMock.undo } as never);
    });
    afterEach(() => vi.useRealTimers());

    it("stops the run, waits for it to settle, then clears with an Undo toast", async () => {
      const id = useAssistant.getState().push(runningCard({ undo: [{ id: "a", accountId: "g", folderId: "INBOX", unread: false, starred: false }] }));
      const p = clearChat();
      expect(useAssistant.getState().items).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(useAssistant.getState().items).toHaveLength(1);
      useAssistant.getState().patchCard(id, { status: "partial" });
      await p;
      expect(useAssistant.getState().items).toEqual([]);
      expect(toastMock.message).toHaveBeenCalledTimes(1);
      const [msg, opts] = toastMock.message.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
      expect(msg).toBe("Stopped “Move to Trash: 214 emails” — 88 were already moved.");
      expect(opts.action.label).toBe("Undo");
      opts.action.onClick();
      expect(bulkMock.undo).toHaveBeenCalled();
    });

    it("clears after 4 seconds if the run never settles", async () => {
      useAssistant.getState().push(runningCard());
      const p = clearChat();
      await vi.advanceTimersByTimeAsync(3900);
      expect(useAssistant.getState().items).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(200);
      await p;
      expect(useAssistant.getState().items).toEqual([]);
      expect(toastMock.message.mock.calls[0][0]).toContain("may still finish in the background");
    });

    it("waits up to 4 seconds for an undo in flight", async () => {
      const id = useAssistant.getState().push(bulk("undoing"));
      const p = clearChat();
      await vi.advanceTimersByTimeAsync(500);
      useAssistant.getState().patchCard(id, { undoing: false, status: "undone" });
      await p;
      expect(useAssistant.getState().items).toEqual([]);
    });

    it("ignores sends while clearing, and repeated Clear is one clear", async () => {
      const id = useAssistant.getState().push(runningCard({ undo: [{ id: "a", accountId: "g", folderId: "INBOX", unread: false, starred: false }] }));
      const p1 = clearChat();
      const p2 = clearChat();
      expect(p2).toBe(p1);
      expect(useAssistant.getState().clearing).toBe(true);
      expect(submitAction("hello", false, true)).toBe("ignore");
      expect(submitAction("/clear", false, true)).toBe("clear");
      useAssistant.getState().patchCard(id, { status: "partial" });
      await p1;
      expect(useAssistant.getState().clearing).toBe(false);
      expect(toastMock.message).toHaveBeenCalledTimes(1);
    });

    it("offers no Undo when the card never settled", async () => {
      useAssistant.getState().push(runningCard({ undo: [{ id: "a", accountId: "g", folderId: "INBOX", unread: false, starred: false }] }));
      const p = clearChat();
      await vi.advanceTimersByTimeAsync(4100);
      await p;
      expect(toastMock.message.mock.calls[0][1]).toBeUndefined();
    });

    it("says Finished for a run that completed, and skips the toast for an undone card", async () => {
      const a = useAssistant.getState().push(runningCard());
      const p = clearChat();
      useAssistant.getState().patchCard(a, { status: "done" });
      await p;
      expect(toastMock.message.mock.calls[0][0]).toBe("Finished “Move to Trash: 214 emails” — 88 moved.");
      toastMock.message.mockClear();
      const b = useAssistant.getState().push(bulk("undoing"));
      const p2 = clearChat();
      useAssistant.getState().patchCard(b, { undoing: false, status: "undone" });
      await p2;
      expect(toastMock.message).not.toHaveBeenCalled();
    });

    it("/clear while busy still clears", async () => {
      useAssistant.setState({ busy: true });
      useAssistant.getState().push(runningCard());
      expect(submitAction("/clear", true)).toBe("clear");
      const p = clearChat();
      await vi.advanceTimersByTimeAsync(4100);
      await p;
      expect(useAssistant.getState().items).toEqual([]);
      useAssistant.setState({ busy: false });
    });
  });

  it("clears when bulk cards are finished", async () => {
    useAssistant.getState().push(bulk("done"));
    await clearChat();
    expect(useAssistant.getState().items).toEqual([]);
  });

  it("parseCommand recognises /clear and /new only", () => {
    for (const t of ["/clear", "/CLEAR ", "  /new", "/New"]) expect(parseCommand(t)).toBe("clear");
    for (const t of ["clear", "/clear now", "/clearx", "hello /clear", ""]) expect(parseCommand(t)).toBeNull();
  });
});

describe("submitAction", () => {
  it("lets /clear through while busy, ignores other text while busy, asks when idle", () => {
    expect(submitAction("/clear", true)).toBe("clear");
    expect(submitAction("/new", false)).toBe("clear");
    expect(submitAction("hello", true)).toBe("redirect");
    expect(submitAction("hello", false)).toBe("ask");
    expect(submitAction("   ", false)).toBe("ignore");
  });

  it("treats a typed /clear-family command as clear", () => {
    expect(submitAction("/new", true)).toBe("clear");
    expect(submitAction("/clear", false)).toBe("clear");
    expect(submitAction("/find x", true)).toBe("redirect");
    expect(submitAction("more detail", true)).toBe("redirect");
    expect(submitAction("more detail", true, true)).toBe("ignore");
    expect(submitAction("/clear", true)).toBe("clear");
  });

  it("only a bare /clear or /new clears; with text it's a plain message", () => {
    for (const t of ["/clear", " /CLEAR ", "/new", "/New "]) expect(submitAction(t, false)).toBe("clear");
    expect(submitAction("/clear out amazon mail", false)).toBe("ask");
    expect(submitAction("/new folder for receipts", false)).toBe("ask");
    expect(submitAction("/clear out amazon mail", true)).toBe("redirect");
  });
});

describe("planSend", () => {
  const clear = findCommand("clear")!;
  const summarize = findCommand("summarize")!;
  const find = findCommand("find")!;

  it("a bare /clear (typed or as a chip) clears, even while busy", () => {
    expect(planSend(null, "/clear", false, false)).toEqual({ kind: "clear" });
    expect(planSend(null, "/new", true, false)).toEqual({ kind: "clear" });
    expect(planSend(clear, "", true, false)).toEqual({ kind: "clear" });
  });

  it("/clear with text sends the text as a plain message", () => {
    expect(planSend(null, "/clear out amazon mail", false, false)).toEqual({ kind: "plain", text: "/clear out amazon mail" });
    expect(planSend(clear, "out amazon mail", false, false)).toEqual({ kind: "plain", text: "out amazon mail" });
    expect(planSend(clear, "out amazon mail", true, false)).toEqual({ kind: "plain", text: "out amazon mail", redirect: true });
  });

  it("commands need their argument; no-argument commands pass text through", () => {
    expect(planSend(find, "", false, false)).toBeNull();
    expect(planSend(find, "when is the dentist", false, false)).toEqual({ kind: "command", command: find, arg: "when is the dentist" });
    expect(planSend(summarize, "", false, false)).toEqual({ kind: "command", command: summarize, arg: "" });
    expect(planSend(summarize, "focus on dates", false, false)).toEqual({ kind: "command", command: summarize, arg: "focus on dates" });
    expect(planSend(null, "/summarize focus on dates", false, false)).toEqual({ kind: "command", command: summarize, arg: "focus on dates" });
    expect(planSend(summarize, "", true, false)).toEqual({ kind: "command", command: summarize, arg: "", redirect: true });
    expect(planSend(find, "", true, false)).toBeNull();
    expect(planSend(find, "dentist", true, false)).toEqual({ kind: "command", command: find, arg: "dentist", redirect: true });
    expect(planSend(null, "more detail", true, false)).toEqual({ kind: "plain", text: "more detail", redirect: true });
    expect(planSend(null, "more detail", true, true)).toBeNull();
    expect(planSend(null, "hello", false, false)).toEqual({ kind: "plain", text: "hello" });
    expect(planSend(null, "hello", false, true)).toBeNull();
  });
});
