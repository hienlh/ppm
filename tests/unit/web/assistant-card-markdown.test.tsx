/**
 * A PPM Assistant card's body is drawn with the chat's Markdown renderer in its card mode: bold,
 * code and lists render; HTML the manager wrote is shown as text; nothing is fetched on its own (an
 * outside image becomes a link, a local one a label, with no request to PPM's file API); every
 * link opens in a new tab and an unsafe scheme is dropped. The text still folds behind Show more.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { AssistantCard } = await import("../../../src/web/components/assistant/cards/assistant-card");
const { CardText } = await import("../../../src/web/components/assistant/cards/card-shell");
type Card = import("../../../src/shared/assistant-cards").AssistantCard;

const card = (body: string): Card => ({
  id: "22222222-2222-2222-2222-222222222222", kind: "done", projectName: "nxsys", projectKey: "k", sessionId: "mgr-1",
  title: "NX-6318 ready", body, payload: {}, status: "open", answer: null, provenance: "Written by the nxsys manager AI",
  createdAt: Date.now(), updatedAt: Date.now(),
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const text = () => view!.container.querySelector("[data-card-text]")!;

describe("a card body as Markdown", () => {
  it("renders bold, code, lists and headings", async () => {
    view = await mount(<AssistantCard card={card("## Status\n- **Fix** in `period-close.ts`\n- Run `a<b && c`")} />);
    const box = text();
    expect(box.querySelector("h2")?.textContent).toBe("Status");
    expect(box.querySelectorAll("li").length).toBe(2);
    expect(box.querySelector("strong")?.textContent).toBe("Fix");
    expect([...box.querySelectorAll("code")].map((c) => c.textContent)).toEqual(["period-close.ts", "a<b && c"]);
  });

  it("shows HTML the manager wrote as text", async () => {
    view = await mount(<AssistantCard card={card('<img src="x" onerror="alert(1)"> <b>hi</b> <script>alert(2)</script>')} />);
    const box = text();
    expect(box.querySelector("img, b, script")).toBeNull();
    expect(box.textContent).toContain('<img src="x" onerror="alert(1)">');
    expect(box.textContent).toContain("<b>hi</b>");
  });

  it("loads no image, outside or local", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      view = await mount(<AssistantCard card={card("![tracker](https://evil.test/p.png?k=secret) ![shot](/home/u/shot.png)")} />);
      await new Promise((r) => setTimeout(r, 10));
      const box = text();
      expect(box.querySelector("img")).toBeNull();
      expect(box.textContent).toContain("Image: tracker");
      expect(box.textContent).toContain("Image: shot");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("opens links in a new tab and drops an unsafe scheme", async () => {
    view = await mount(<AssistantCard card={card("[PR](https://github.test/pull/1) [mail](mailto:a@b.test) [bad](javascript:alert(1))")} />);
    const links = [...text().querySelectorAll("a")];
    const byText = (t: string) => links.find((a) => a.textContent === t);
    expect(byText("PR")?.getAttribute("target")).toBe("_blank");
    expect(byText("PR")?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(byText("mail")?.getAttribute("target")).toBe("_blank");
    // A refused scheme is just its text: an empty href would reload the whole app.
    expect(byText("bad")).toBeUndefined();
    expect(text().textContent).toContain("bad");
  });

  it("names the host a link goes to when its label does not", async () => {
    view = await mount(<AssistantCard card={card("[github.com/acme/pull/12](https://evil.test/x) and [docs.test page](https://docs.test/a)")} />);
    const hosts = [...text().querySelectorAll("[data-link-host]")].map((n) => n.textContent);
    expect(hosts).toEqual([" (evil.test)"]);
  });

  it("still folds long Markdown behind Show more", async () => {
    const real = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 900 });
    try {
      view = await mount(<CardText text={"- **one**\n".repeat(30)} fold />);
      expect(text().className).toContain("max-h-[11.25rem]");
      expect(view.container.querySelector("[data-card-text-toggle]")?.textContent).toBe("Show more");
      expect(text().querySelector("strong")).not.toBeNull();
    } finally {
      if (real) Object.defineProperty(HTMLElement.prototype, "scrollHeight", real);
      else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
  });
});
