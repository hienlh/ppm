/**
 * Settings → Memory → Search by meaning (requirements 9.1–9.4, 11.2): the Off / Local model / API
 * control saves its source; the local model shows its size before installing, its progress while
 * installing (also from `memory:embed-install`), and Remove and the vector count when ready; the
 * API form always warns, never sends an empty key, and Test shows the result or the endpoint's
 * error; whenever vectors cannot be used, "Searching by words only" with the reason.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { api } = await import("../../../src/web/lib/api-client");

const MB = 1024 * 1024;

function embedding(overrides: Record<string, unknown> = {}) {
  return {
    source: "local",
    has_api_key: false,
    model: "local:Xenova/multilingual-e5-small@q8",
    ready: true,
    reason: null,
    vectors: 113,
    total: 116,
    running: true,
    install: { state: "ready" },
    ...overrides,
  };
}

const notInstalled = () => embedding({
  ready: false, reason: "The local model is not installed", vectors: 0, running: false,
  install: { state: "not-installed" },
});

const apiSource = (overrides: Record<string, unknown> = {}) => embedding({
  source: "api", api_url: "https://api.openai.com/v1", api_model: "text-embedding-3-small",
  has_api_key: true, model: "api:https://api.openai.com/v1#text-embedding-3-small",
  install: { state: "not-installed" }, ...overrides,
});

interface Calls {
  posts: Array<{ path: string; body: unknown }>;
  puts: Array<{ path: string; body: unknown }>;
  dels: string[];
  changed: number;
}

let view: Mounted | null = null;
let restore: Array<() => void> = [];
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const r of restore) r();
  restore = [];
});

async function flush() {
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}

type Props = { embedding: Record<string, unknown>; onChanged: () => void };

/** Mounts the control on `emb`; `testAnswer` is what POST /embedding/test answers. */
async function render(emb: Record<string, unknown>, testAnswer: () => Promise<unknown> = () => Promise.resolve({ ok: true, dims: 1536, ms: 240 })): Promise<Calls> {
  const calls: Calls = { posts: [], puts: [], dels: [], changed: 0 };
  const post = spyOn(api, "post").mockImplementation(((path: string, body: unknown) => {
    calls.posts.push({ path, body });
    if (path === "/api/memory/embedding/test") return testAnswer();
    if (path === "/api/memory/embedding/install") {
      return Promise.resolve({ state: "installing", step: "packages", bytes: 0, totalBytes: 650 * MB });
    }
    return Promise.reject(new Error("not mocked"));
  }) as never);
  const put = spyOn(api, "put").mockImplementation(((path: string, body: unknown) => {
    calls.puts.push({ path, body });
    return Promise.resolve({ enabled: true, embedding: (body as { embedding: unknown }).embedding });
  }) as never);
  const del = spyOn(api, "del").mockImplementation(((path: string) => {
    calls.dels.push(path);
    return Promise.resolve();
  }) as never);
  restore.push(() => post.mockRestore(), () => put.mockRestore(), () => del.mockRestore());
  // A missing component fails as an assertion, not as a load error.
  const mod = await import("../../../src/web/components/settings/memory-embedding-source").catch(() => null);
  const Comp = (mod as { MemoryEmbeddingSource?: (p: Props) => React.ReactNode } | null)?.MemoryEmbeddingSource;
  expect(Comp).toBeDefined();
  const C = Comp!;
  view = await mount(<C embedding={emb} onChanged={() => { calls.changed++; }} />);
  await flush();
  return calls;
}

const text = () => view!.container.textContent ?? "";
const buttons = () => Array.from(view!.container.querySelectorAll("button"));
/** The button whose own text is exactly `label` (trimmed). */
const button = (label: string) => {
  const b = buttons().find((x) => x.textContent?.trim() === label) ?? null;
  expect(b).not.toBeNull();
  return b as HTMLButtonElement;
};
const startsWith = (label: string) => {
  const b = buttons().find((x) => x.textContent?.trim().startsWith(label)) ?? null;
  expect(b).not.toBeNull();
  return b as HTMLButtonElement;
};

/** The labelled input (by its <label> text). */
function field(label: string): HTMLInputElement {
  const lab = Array.from(view!.container.querySelectorAll("label")).find((l) => l.textContent?.trim() === label);
  expect(lab).toBeDefined();
  const id = lab!.getAttribute("for");
  const input = id ? view!.container.querySelector<HTMLInputElement>(`[id="${id}"]`) : lab!.querySelector("input");
  expect(input).not.toBeNull();
  return input as HTMLInputElement;
}

async function type(el: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickAndFlush(el: Element) {
  await click(el);
  await flush();
}

describe("MemoryEmbeddingSource: the source control", () => {
  it("shows the heading and the three sources", async () => {
    await render(embedding());
    expect(text()).toContain("Search by meaning");
    expect(text()).toContain("Word search always works.");
    button("Off");
    button("Local model");
    button("API");
  });

  it("marks the current source as pressed", async () => {
    await render(embedding());
    expect(button("Local model").getAttribute("aria-pressed")).toBe("true");
    expect(button("Off").getAttribute("aria-pressed")).toBe("false");
    expect(button("API").getAttribute("aria-pressed")).toBe("false");
  });

  it("lays the selector out as a 3-column grid of 40px buttons below md", async () => {
    await render(embedding());
    const group = button("Off").parentElement!;
    expect(group.className).toContain("grid-cols-3");
    for (const label of ["Off", "Local model", "API"]) expect(button(label).className).toContain("h-10");
  });

  it("choosing Local model saves the source and reloads", async () => {
    const calls = await render(embedding({ source: "off", ready: false, reason: "No embedding source is set; search uses full text only" }));
    await clickAndFlush(button("Local model"));
    expect(calls.puts).toEqual([{ path: "/api/memory/settings", body: { embedding: { source: "local" } } }]);
    expect(calls.changed).toBeGreaterThan(0);
  });

  it("choosing Off saves the source", async () => {
    const calls = await render(embedding());
    await clickAndFlush(button("Off"));
    expect(calls.puts).toEqual([{ path: "/api/memory/settings", body: { embedding: { source: "off" } } }]);
  });

  it("choosing API with an endpoint already saved saves the source", async () => {
    const calls = await render(apiSource({ source: "local" }));
    await clickAndFlush(button("API"));
    expect(calls.puts).toEqual([{ path: "/api/memory/settings", body: { embedding: { source: "api" } } }]);
  });

  it("choosing API with no endpoint yet opens the form without saving", async () => {
    const calls = await render(embedding({ source: "off", ready: false, reason: "No embedding source is set; search uses full text only" }));
    await clickAndFlush(button("API"));
    expect(calls.puts).toEqual([]);
    expect(text()).toContain("Endpoint URL");
    expect(button("API").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("MemoryEmbeddingSource: Local model", () => {
  it("not installed: shows the size before installing and words-only with the reason", async () => {
    await render(notInstalled());
    expect(text()).toContain("The model is not installed.");
    expect(text()).toContain("multilingual-e5-small understands Vietnamese and English and runs on the CPU.");
    expect(text()).toContain("runtime 520 MB + model 130 MB");
    expect(text()).toContain("about 1 GB of RAM");
    expect(text()).toContain("stops after 10 minutes without a search");
    startsWith("Install (≈ 650 MB)");
    expect(text()).toContain("Searching by words only");
    expect(text()).toContain("The local model is not installed");
  });

  it("Install POSTs and shows the install starting", async () => {
    const calls = await render(notInstalled());
    await clickAndFlush(startsWith("Install (≈ 650 MB)"));
    expect(calls.posts.map((p) => p.path)).toEqual(["/api/memory/embedding/install"]);
    expect(text()).toContain("Installing the model…");
  });

  it("installing: shows progress in MB with a bar, and Cancel DELETEs", async () => {
    const calls = await render(embedding({
      ready: false, reason: "The local model is installing", vectors: 0, running: false,
      install: { state: "installing", step: "model", bytes: 372 * MB, totalBytes: 650 * MB },
    }));
    expect(text()).toContain("Installing the model…");
    expect(text()).toContain("372 / 650 MB");
    const bar = view!.container.querySelector('[role="progressbar"]');
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute("aria-valuenow")).toBe("57");
    expect(text()).toContain("Searching by words only");
    await clickAndFlush(button("Cancel"));
    expect(calls.dels).toEqual(["/api/memory/embedding/install"]);
  });

  it("an install event updates the progress", async () => {
    await render(embedding({
      ready: false, reason: "The local model is installing", vectors: 0, running: false,
      install: { state: "installing", step: "packages", bytes: 10 * MB, totalBytes: 650 * MB },
    }));
    expect(text()).toContain("10 / 650 MB");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("memory:embed-install", {
        detail: { type: "memory:embed-install", status: { state: "installing", step: "model", bytes: 500 * MB, totalBytes: 650 * MB } },
      }));
    });
    await flush();
    expect(text()).toContain("500 / 650 MB");
    expect(view!.container.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("77");
  });

  it("an install event that finishes asks the section to reload", async () => {
    const calls = await render(embedding({
      ready: false, reason: "The local model is installing", vectors: 0, running: false,
      install: { state: "installing", step: "model", bytes: 600 * MB, totalBytes: 650 * MB },
    }));
    await act(async () => {
      window.dispatchEvent(new CustomEvent("memory:embed-install", {
        detail: { type: "memory:embed-install", status: { state: "ready" } },
      }));
    });
    await flush();
    expect(calls.changed).toBeGreaterThan(0);
  });

  it("ready: shows the model, the vector count and Remove, which DELETEs; no words-only note", async () => {
    const calls = await render(embedding());
    expect(text()).toContain("multilingual-e5-small · runs on this machine");
    expect(text()).toContain("Nothing leaves this machine.");
    expect(text()).toContain("113 of 116 memories have meanings");
    expect(text()).not.toContain("Searching by words only");
    await clickAndFlush(button("Remove"));
    expect(calls.dels).toEqual(["/api/memory/embedding/install"]);
  });

  it("failed: shows the reason and Try again POSTs the install", async () => {
    const calls = await render(embedding({
      ready: false, reason: "The local model failed to install: bun add exited 1", vectors: 0, running: false,
      install: { state: "failed", reason: "bun add exited 1" },
    }));
    expect(text()).toContain("bun add exited 1");
    expect(text()).toContain("Searching by words only");
    await clickAndFlush(button("Try again"));
    expect(calls.posts.map((p) => p.path)).toEqual(["/api/memory/embedding/install"]);
  });
});

describe("MemoryEmbeddingSource: API", () => {
  const WARNING = "Every memory's text is sent to this endpoint to compute its meaning, and each search query too.";

  it("always warns, shows the saved URL and model, and the key as dots", async () => {
    await render(apiSource());
    expect(text()).toContain(WARNING);
    expect(field("Endpoint URL").value).toBe("https://api.openai.com/v1");
    expect(field("Model").value).toBe("text-embedding-3-small");
    const key = field("API key");
    expect(key.value).toBe("");
    expect(key.type).toBe("password");
    expect(key.placeholder).toContain("••••");
  });

  it("warns when there is no key too", async () => {
    await render(apiSource({ has_api_key: false }));
    expect(text()).toContain(WARNING);
    expect(field("API key").placeholder).not.toContain("••••");
  });

  it("Save sends the URL and model and leaves an empty key out", async () => {
    const calls = await render(apiSource());
    await type(field("Model"), "text-embedding-3-large");
    await clickAndFlush(button("Save"));
    expect(calls.puts).toEqual([{
      path: "/api/memory/settings",
      body: { embedding: { source: "api", api_url: "https://api.openai.com/v1", api_model: "text-embedding-3-large" } },
    }]);
    expect(calls.changed).toBeGreaterThan(0);
  });

  it("Save sends a key that was typed", async () => {
    const calls = await render(apiSource({ has_api_key: false }));
    await type(field("API key"), "sk-new");
    await clickAndFlush(button("Save"));
    expect(calls.puts[0]!.body).toEqual({
      embedding: { source: "api", api_url: "https://api.openai.com/v1", api_model: "text-embedding-3-small", api_key: "sk-new" },
    });
  });

  it("Test embeds with the form's settings and shows the dimensions and time", async () => {
    const calls = await render(apiSource());
    await clickAndFlush(button("Test"));
    expect(calls.posts).toEqual([{
      path: "/api/memory/embedding/test",
      body: { source: "api", api_url: "https://api.openai.com/v1", api_model: "text-embedding-3-small" },
    }]);
    expect(text()).toContain("Works · 1,536 dimensions · 240 ms");
  });

  it("Test shows the endpoint's error", async () => {
    await render(apiSource(), () => Promise.resolve({ ok: false, error: "401 from the endpoint: Incorrect API key provided." }));
    await clickAndFlush(button("Test"));
    expect(text()).toContain("401 from the endpoint: Incorrect API key provided.");
    expect(text()).not.toContain("Works ·");
  });

  it("Test shows a refused request's error", async () => {
    await render(apiSource(), () => Promise.reject(new Error("api_url must be an http(s) URL")));
    await clickAndFlush(button("Test"));
    expect(text()).toContain("api_url must be an http(s) URL");
  });

  it("shows words-only with the reason when the endpoint is down", async () => {
    await render(apiSource({ reason: "The endpoint did not answer (connection refused)" }));
    expect(text()).toContain("Searching by words only");
    expect(text()).toContain("The endpoint did not answer (connection refused)");
  });
});

describe("MemoryEmbeddingSource: Off", () => {
  it("shows words-only with the reason", async () => {
    await render(embedding({
      source: "off", ready: false, reason: "No embedding source is set; search uses full text only",
      model: null, vectors: 0, install: { state: "not-installed" },
    }));
    expect(text()).toContain("Searching by words only");
    expect(text()).toContain("No embedding source is set; search uses full text only");
    expect(text()).not.toContain("The model is not installed.");
    expect(text()).not.toContain("Endpoint URL");
  });
});
