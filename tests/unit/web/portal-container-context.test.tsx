import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PortalContainerProvider,
  usePortalContainer,
} from "../../../src/web/components/ui/portal-container-context.tsx";

/**
 * A stand-in for an HTMLElement. This test suite has no DOM harness, but the
 * context and hook only ever pass the value through — a tagged object proves
 * identity/propagation just as well as a real node would.
 */
function fakeContainer(id: string): HTMLElement {
  return { __fakeContainerId: id } as unknown as HTMLElement;
}

function ReportContainer({ label }: { label: string }) {
  const container = usePortalContainer();
  const id = container ? (container as unknown as { __fakeContainerId: string }).__fakeContainerId : "undefined";
  return <span data-label={label} data-container-id={id} />;
}

describe("usePortalContainer", () => {
  test("returns undefined outside any provider", () => {
    const markup = renderToStaticMarkup(<ReportContainer label="none" />);
    expect(markup).toContain('data-container-id="undefined"');
  });

  test("returns the container supplied by the nearest provider", () => {
    const container = fakeContainer("pip-body");
    const markup = renderToStaticMarkup(
      <PortalContainerProvider container={container}>
        <ReportContainer label="provided" />
      </PortalContainerProvider>,
    );
    expect(markup).toContain('data-container-id="pip-body"');
  });

  test("a nested provider overrides its ancestor's container", () => {
    const outer = fakeContainer("outer");
    const inner = fakeContainer("inner");
    const markup = renderToStaticMarkup(
      <PortalContainerProvider container={outer}>
        <PortalContainerProvider container={inner}>
          <ReportContainer label="nested" />
        </PortalContainerProvider>
      </PortalContainerProvider>,
    );
    expect(markup).toContain('data-container-id="inner"');
  });

  test("a provider explicitly set to undefined restores the document default", () => {
    const markup = renderToStaticMarkup(
      <PortalContainerProvider container={fakeContainer("outer")}>
        <PortalContainerProvider container={undefined}>
          <ReportContainer label="restored" />
        </PortalContainerProvider>
      </PortalContainerProvider>,
    );
    expect(markup).toContain('data-container-id="undefined"');
  });
});
