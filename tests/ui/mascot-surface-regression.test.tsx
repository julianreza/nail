import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MascotIllustration from "../../app/mascot-illustration";

const render = () => renderToStaticMarkup(createElement(MascotIllustration));

describe("monster surface regressions", () => {
  it("does not erase the face through its own parent mask", () => {
    const html = render();
    expect(html).not.toContain("-body-mask");
    expect(html).toContain('data-mascot-surface="face"');
  });

  it("moves the entire masked antenna inside a separate transform wrapper", () => {
    const html = render();
    expect(html).toMatch(/class="mascot-antenna" data-mascot-surface="antenna"><g mask="url\(#[^"]+-antenna-mask\)"[^>]*>/);
    expect(html).toContain('data-antenna-pivot="123.5156 42.1094"');
  });

  it("keeps the eyelid invisible without login-specific styles", () => {
    const html = render();
    expect(html).toMatch(/class="mascot-eyelid"[^>]*opacity="0"/);
  });

  it("closes over the full eye rim with a lid crease, not a green disc inside a white ring", () => {
    const html = render();
    expect(html).toContain('data-mascot-eyelid-crease="true"');
    expect(html).toContain('rx="34" ry="33"');
  });

  it("keeps every mask and filter instance local", () => {
    const html = renderToStaticMarkup(createElement("div", null, createElement(MascotIllustration), createElement(MascotIllustration)));
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const match of html.matchAll(/url\(#([^)]*)\)/g)) expect(ids).toContain(match[1]);
  });
});
