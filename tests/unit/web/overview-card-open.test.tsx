/**
 * An Overview card opens its Performance device page.
 *
 * Two things are pinned because both look right in review and are wrong in use.
 * A card with no target must stay a plain frame, not a button that does nothing —
 * a host reporting no drives at all has no Disk page to open. And the button
 * needs an explicit `aria-label`: a button's name is otherwise computed from its
 * contents, which here is the entire card, so a screen reader would announce
 * "CPU 6.9% 12th Gen Intel(R) Core(TM) i9-12900K" as the name of the control.
 */
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CardShell } from "../../../src/web/components/system/overview-cards/card-shell.tsx";
import { CpuCard } from "../../../src/web/components/system/overview-cards/cpu-card.tsx";
import { DiskCard } from "../../../src/web/components/system/overview-cards/disk-card.tsx";

const noop = () => {};

describe("CardShell", () => {
  it("is a button when it has somewhere to go", () => {
    const html = renderToStaticMarkup(
      <CardShell testId="t" onOpen={noop} openLabel="CPU details"><p>body</p></CardShell>,
    );
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="CPU details"');
  });

  it("is a plain frame when it does not", () => {
    const html = renderToStaticMarkup(<CardShell testId="t"><p>body</p></CardShell>);
    expect(html).not.toContain("<button");
    expect(html).toContain("<div");
  });

  it("keeps the card's own data attributes either way", () => {
    for (const onOpen of [noop, undefined]) {
      const html = renderToStaticMarkup(
        <CardShell testId="sysmon-card-disk" data={{ "data-available": false }} onOpen={onOpen} openLabel="x">
          <p>body</p>
        </CardShell>,
      );
      expect(html).toContain('data-testid="sysmon-card-disk"');
      expect(html).toContain('data-available="false"');
    }
  });

  it("a button still lays out as a card: full width, text left", () => {
    // A button centres its content and shrinks to it, which in a CSS grid makes
    // the card narrower than its column and every label centred.
    const html = renderToStaticMarkup(
      <CardShell testId="t" onOpen={noop} openLabel="x"><p>body</p></CardShell>,
    );
    expect(html).toContain("w-full");
    expect(html).toContain("text-left");
  });

  it("carries a visible focus ring, since it is now keyboard-reachable", () => {
    const html = renderToStaticMarkup(
      <CardShell testId="t" onOpen={noop} openLabel="x"><p>body</p></CardShell>,
    );
    expect(html).toContain("focus-visible:outline");
  });
});

describe("the cards themselves", () => {
  const cpu = { total: 6.9, cores: [5, 7], model: "i9-12900K", series: [6, 7] };

  it("the CPU card becomes a button and keeps its reading", () => {
    const html = renderToStaticMarkup(<CpuCard {...cpu} onOpen={noop} />);
    expect(html).toContain("<button");
    expect(html).toContain('aria-label="CPU details"');
    expect(html).toContain("6.9%");
    expect(html).toContain('data-cpu-total="6.9"');
  });

  it("without a handler the CPU card renders exactly as it always did", () => {
    const html = renderToStaticMarkup(<CpuCard {...cpu} />);
    expect(html).not.toContain("<button");
    expect(html).toContain("6.9%");
    expect(html).toContain('data-cpu-total="6.9"');
  });

  it("a Disk card with no drive to open is not a button", () => {
    // `onOpen` is undefined because `busiestDiskKey` answered null.
    const html = renderToStaticMarkup(
      <DiskCard available={false} inBps={0} outBps={0} readSeries={[]} writeSeries={[]} measuring />,
    );
    expect(html).not.toContain("<button");
    expect(html).toContain("measuring");
  });

  it("an unavailable Disk card is still clickable when a drive exists", () => {
    // "The whole-machine rate needs two samples" and "there is no drive" are
    // different things; only the second one removes the destination.
    const html = renderToStaticMarkup(
      <DiskCard available={false} inBps={0} outBps={0} readSeries={[]} writeSeries={[]} measuring onOpen={noop} />,
    );
    expect(html).toContain("<button");
    expect(html).toContain('aria-label="Disk details"');
  });
});
