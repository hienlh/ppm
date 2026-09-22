import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createOnboardingHarness } from "./fixtures/onboarding-harness.mjs";

const h = await createOnboardingHarness();
const results = [];
try {
  for (const [name, width, reducedMotion] of [["desktop",1366,"no-preference"],["mobile",390,"no-preference"],["reduced",390,"reduce"]]) {
    const context = await h.browser.newContext({ viewport: {width,height:900}, reducedMotion, recordVideo: name !== "reduced" ? {dir:h.artifacts,size:{width,height:900}} : undefined });
    await context.addInitScript(({api,web}) => {
      const Socket = window.WebSocket;
      window.WebSocket = class extends Socket {
        constructor(input, protocols) {
          const url = new URL(String(input), location.href);
          if (url.hostname === "127.0.0.1" && url.port === "8081" && url.pathname.startsWith("/ws/")) url.port = new URL(api).port;
          if (![new URL(api).host,new URL(web).host].includes(url.host)) throw Error("Outside sandbox");
          super(url.href,protocols);
        }
      };
      window.motionEvidence = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) {
        if (this.hasAttribute("data-onboarding-transition")) window.motionEvidence.push({step:this.getAttribute("data-onboarding-transition"),frames,options});
        return animate.call(this,frames,options);
      };
    }, {api:h.api,web:h.web});
    await context.route("**/*", route => [new URL(h.web).host,new URL(h.api).host].includes(new URL(route.request().url()).host) ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors=[]; page.on("pageerror", error => errors.push(error.message));
    await page.goto(h.web);
    await page.getByRole("button",{name:"Start guided tour",exact:true}).click();
    await page.getByRole("button",{name:"I'm just getting started",exact:false}).click();
    await page.getByRole("heading",{name:"What would you like to do first?"}).waitFor();
    // Intentional pacing in the recorded demonstration, not a readiness condition.
    await page.waitForTimeout(450);
    await page.getByRole("button",{name:"Back",exact:true}).click();
    await page.waitForTimeout(450);
    await page.getByRole("button",{name:"I've used similar tools",exact:false}).click();
    await page.waitForTimeout(450);
    await page.getByRole("button",{name:"Explore a project",exact:false}).click();
    const tour = page.getByRole("complementary",{name:"PPM guided tour"});
    await tour.getByRole("button",{name:"Skip step",exact:true}).click();
    await page.waitForTimeout(450);
    await tour.getByRole("button",{name:"Back",exact:true}).click();
    await page.waitForTimeout(450);
    await tour.getByRole("button",{name:"Quick orientation",exact:true}).click();
    await page.getByRole("button",{name:width>768?"Left rail":"Navigation buttons",exact:true}).click();
    await page.waitForTimeout(450);
    await page.getByRole("button",{name:"Command Palette",exact:true}).click();
    await page.waitForTimeout(450);
    const evidence = await page.evaluate(() => window.motionEvidence);
    if (reducedMotion === "reduce") assert.equal(evidence.length,0);
    else {
      for (const step of ["goal","level","file","project","rail","palette"]) assert.ok(evidence.some(e=>e.step===step),step);
      assert.ok(evidence.some(e=>e.frames[0].transform==="translateX(-12px)"));
      assert.ok(evidence.some(e=>e.frames[0].transform==="translateX(12px)"));
      assert.ok(evidence.every(e=>e.options.duration===200));
      // Rapid changes cancel the prior animation; live reduced-motion cancels the last.
      await page.getByRole("button",{name:width>768?"Left rail":"Navigation buttons",exact:true}).click();
      await page.getByRole("button",{name:"Command Palette",exact:true}).click();
      await page.emulateMedia({reducedMotion:"reduce"});
    }
    await page.waitForFunction(() => [...document.querySelectorAll('[data-onboarding-transition]')].every(el=>el.getAnimations().length===0 && getComputedStyle(el).opacity==="1"));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:join(h.artifacts,`${name}-motion-complete.png`),fullPage:true});
    const video=page.video(); await context.close();
    if(video) await video.saveAs(join(h.artifacts,`${name}-step-animation.webm`));
    results.push({name,passed:true,animations:evidence.length}); console.log(`PASS ${name}`);
  }
} finally {
  await h.browser.close(); await h.cleanup();
  await writeFile(join(h.artifacts,"results.json"),JSON.stringify({isolation:{sandbox:h.sandbox,api:h.api,web:h.web},results},null,2));
}
