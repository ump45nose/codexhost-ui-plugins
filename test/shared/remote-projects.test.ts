import { describe, expect, it } from "vitest";
import {
  collectSidebarRemoteProjects,
  createRemoteHostGlobe,
  findReactProps,
  readRemoteHostGlobeColors,
  resolveShortHostLabel,
} from "../../shared/remote-projects.ts";
import { FakeDocument } from "../plugins/vertical/fake-dom.ts";

describe("shared/remote-projects", () => {
  it("walks React fiber chain via findReactProps", () => {
    const doc = new FakeDocument();
    const el = doc.createElement("div");
    Object.defineProperty(el, "__reactFiber$abc", {
      value: {
        memoizedProps: { title: "leaf" },
        return: {
          memoizedProps: { hostId: "remote-ssh:nas" },
        },
      },
    });
    expect(
      findReactProps(el as unknown as Element, (props) =>
        typeof props.hostId === "string" ? props.hostId : null,
      ),
    ).toBe("remote-ssh:nas");
    expect(
      findReactProps(el as unknown as Element, (props) =>
        typeof props.missing === "string" ? props.missing : null,
      ),
    ).toBeNull();
  });

  it("collects and deduplicates sidebar remote projects in sidebar order", () => {
    const doc = new FakeDocument();
    const section = doc.createElement("div");
    section.setAttribute("data-sidebar-project-kind", "remote");

    const makeRow = (group: Record<string, unknown>) => {
      const row = doc.createElement("div");
      row.setAttribute("data-app-action-sidebar-project-row", "true");
      Object.defineProperty(row, "__reactFiber$test", {
        value: { memoizedProps: { group } },
      });
      section.appendChild(row);
    };

    makeRow({
      projectKind: "remote",
      hostId: "remote-ssh:nas",
      hostDisplayName: "NAS",
      projectId: "proj-1",
      label: "codexhost",
      path: "/volume1/dev/codexhost",
    });
    // Duplicate should be skipped
    makeRow({
      projectKind: "remote",
      hostId: "remote-ssh:nas",
      hostDisplayName: "NAS",
      projectId: "proj-1",
      label: "duplicate",
      path: "/volume1/dev/codexhost",
    });
    // Non-remote or missing path should be skipped
    makeRow({
      projectKind: "local",
      hostId: "local",
      projectId: "proj-local",
      path: "/tmp/local",
    });
    makeRow({
      projectKind: "remote",
      hostId: "remote-ssh:mac",
      projectId: "proj-2",
      path: "/Users/dev/app",
    });

    doc.body.appendChild(section);
    expect(collectSidebarRemoteProjects(doc as unknown as Document)).toEqual([
      {
        hostId: "remote-ssh:nas",
        hostDisplayName: "NAS",
        projectId: "proj-1",
        label: "codexhost",
        path: "/volume1/dev/codexhost",
      },
      {
        hostId: "remote-ssh:mac",
        hostDisplayName: "",
        projectId: "proj-2",
        label: "/Users/dev/app",
        path: "/Users/dev/app",
      },
    ]);
  });

  it("reads remote host globe colors and builds SVG globe icons", () => {
    const doc = new FakeDocument();
    const holder = doc.createElement("span");
    holder.setAttribute("data-sidebar-project-kind", "remote");
    const svg = doc.createElement("svg");
    svg.setAttribute("style", "--remote-host-globe-color: #ffc300");
    Object.defineProperty(svg, "__reactFiber$test", {
      value: { memoizedProps: {}, return: { memoizedProps: { hostId: "remote-ssh:nas" } } },
    });
    holder.appendChild(svg);
    doc.body.appendChild(holder);

    const colors = readRemoteHostGlobeColors(doc as unknown as Document);
    expect(colors.get("remote-ssh:nas")).toBe("#ffc300");

    const globe = createRemoteHostGlobe(
      doc as unknown as Document,
      colors.get("remote-ssh:nas") ?? null,
      "codexhost-session-tab-host",
    );
    expect(globe.getAttribute("class")).toBe("codexhost-session-tab-host");
    expect(globe.getAttribute("aria-hidden")).toBe("true");
    expect(globe.querySelector("path")?.getAttribute("fill")).toBe("#ffc300");

    const fallbackGlobe = createRemoteHostGlobe(doc as unknown as Document, null, "globe");
    expect(fallbackGlobe.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
  });

  it("shortens remote host ids and custom names", () => {
    expect(resolveShortHostLabel("local")).toBeNull();
    expect(resolveShortHostLabel("remote-ssh-discovered:mac-work")).toBe("mac-work");
    expect(resolveShortHostLabel("h1", "yuwk@macpro.local:22")).toBe("MacPro");
    expect(resolveShortHostLabel("h2", "192.168.1.20:22")).toBe("192.168.1.20");
    expect(resolveShortHostLabel("remote-ssh-discovered:nas")).toBe("NAS");
  });
});
