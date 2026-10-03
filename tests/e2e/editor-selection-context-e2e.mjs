import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(process.env.PPM_PLAYWRIGHT_MODULE || "playwright");
// Build into a scratch directory first; this runner never writes live dist or PPM data.
// PPM_E2E_DIST=/path/to/scratch/dist node tests/e2e/editor-selection-context-e2e.mjs
const dist = process.env.PPM_E2E_DIST;
assert(dist, "Set PPM_E2E_DIST to an isolated compiled build's dist directory");
const root = await mkdtemp(join(tmpdir(), "ppm-editor-selection-e2e-"));
const configModule = pathToFileURL(resolve(import.meta.dirname, "../../src/services/config.service.ts")).href;
const home=root+"/test-home", ppm=root+"/ppm", artifacts=process.env.PPM_SELECTION_ARTIFACTS || root+"/artifacts";
await Promise.all([home,ppm,artifacts].map(p=>mkdir(p,{recursive:true})));
const env={...process.env, PPM_HOME:ppm, HOME:home, USERPROFILE:home, CLAUDE_CONFIG_DIR:home+"/.claude", CODEX_HOME:home+"/.codex"};
for(const key of ["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","OPENAI_API_KEY","CODEX_API_KEY","CURSOR_API_KEY","PPM_ALLOW_PROD_DB"]) delete env[key];
async function cmd(exe,args,options={}) {
  const child=spawn(exe,args,{env,...options,stdio:["ignore","pipe","pipe"]});let output="";
  child.stdout.on("data",d=>output+=d);child.stderr.on("data",d=>output+=d);
  const code=await new Promise((resolve,reject)=>{child.on("error",reject);child.on("exit",resolve)});
  assert.equal(code,0,output);return output;
}
await writeFile(root+"/setup-test.ts", `import { configService } from ${JSON.stringify(configModule)};
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
configService.set("ai", { ...configService.get("ai"), default_provider: "mock", share_provider_context: false,
providers: { mock: { type: "mock", permission_mode: "bypassPermissions" } } });`);
await cmd("bun",[root+"/setup-test.ts"]);
const listener=createServer();await new Promise(r=>listener.listen(0,"127.0.0.1",r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const origin=`http://127.0.0.1:${port}`;console.log("Isolated binary browser test",origin);
const child=spawn(resolve(dist,"ppm"),["__serve__",String(port),"127.0.0.1"],{env:{...env,PATH:"/usr/bin:/bin"},stdio:["ignore","pipe","pipe"]});
let serverLog="";child.stdout.on("data",d=>serverLog+=d);child.stderr.on("data",d=>serverLog+=d);
async function until(label,fn,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch{} await new Promise(r=>setTimeout(r,100));}throw Error("Timeout: "+label);}
async function api(path,opts={}){const r=await fetch(origin+path,{...opts,headers:{"Content-Type":"application/json"}});const j=await r.json();assert(r.ok&&j.ok,JSON.stringify(j));return j.data;}
let browser;const results=[];
try{
  await until("binary healthy",async()=>{const r=await fetch(origin+"/api/health");return (await r.json()).ok},60000);
  browser=await chromium.launch({headless:true,...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {})});
  for(const [device,viewport] of (process.env.PPM_SELECTION_REAL_FILE ? [["desktop",{width:1280,height:900}]] : [["desktop",{width:1280,height:900}],["mobile",{width:390,height:844}]])){
    const name="binary-selection-"+device,project=root+"/project-"+device;await mkdir(project,{recursive:true});await cmd("git",["init",project]);
    await writeFile(project+"/example.ts", process.env.PPM_SELECTION_REAL_FILE ? await readFile(process.env.PPM_SELECTION_REAL_FILE,"utf8") : "const answer = 42;\nconsole.log(answer);\n\nfunction demo() {\n    return answer;\n}\n");
    if (process.env.PPM_SELECTION_REAL_FILE) {
      await cmd("git", ["-C", project, "add", "example.ts"]);
      await cmd("git", ["-C", project, "-c", "user.name=Selection test", "-c", "user.email=selection@example.test", "commit", "-m", "selection fixture"]);
    }
    await api("/api/projects",{method:"POST",body:JSON.stringify({name,path:project})});
    const session=await api(`/api/project/${name}/chat/sessions`,{method:"POST",body:JSON.stringify({providerId:"mock",title:"Binary reply "+device})});
    const tab={id:"chat-"+device,type:"chat",title:"Selection chat",projectId:name,closable:true,metadata:{projectName:name,sessionId:session.id,providerId:"mock"}};
    const editorTab={id:"editor-"+device,type:"editor",title:"example.ts",projectId:name,closable:true,metadata:{projectName:name,filePath:"example.ts"}};
    const workspace={layout:{panels:{main:{id:"main",tabs:[tab,editorTab],activeTabId:editorTab.id,tabHistory:[tab.id]}},grid:[["main"]],focusedPanelId:"main"}};
    await api(`/api/project/${name}/workspace`,{method:"PUT",body:JSON.stringify({layout:{...workspace.layout,panels:{main:{...workspace.layout.panels.main,activeTabId:tab.id}}}})});
    const context=await browser.newContext({viewport,serviceWorkers:"block"});
    await context.addInitScript(()=>localStorage.setItem("ppm-onboarding-v1",JSON.stringify({version:1,status:"dismissed",familiarity:null,goal:null,currentStep:null,completed:[],skipped:[],projectName:null,sessionId:null})));
    const page=await context.newPage(), errors=[];page.on("pageerror",e=>errors.push(String(e)));
    await page.goto(`${origin}/project/${name}`);
    // `first`/`last` are 0-based view lines. Lines 0-1 of the default fixture are flush-left
    // (Monaco's bulb goes in the glyph margin), line 4 is indented (the bulb sits on the line).
    const selectCode=async(first,last)=>{
      const lines=page.locator('.monaco-editor .view-lines:visible').first();await lines.waitFor();
      // Focus the editor before measuring: focusing a split panel can resize it.
      await lines.locator('.view-line').first().click();
      await page.waitForTimeout(350);
      const bounds=await lines.boundingBox();const y=bounds.y;
      const viewLines = lines.locator('.view-line');
      await viewLines.nth(last).waitFor();
      const start = await viewLines.nth(first).evaluate(node=>node.getBoundingClientRect().toJSON()), end = await viewLines.nth(last).evaluate(node=>node.getBoundingClientRect().toJSON());
      await page.mouse.move(bounds.x+2,start.y+start.height/2);await page.mouse.down();
      await page.mouse.move(bounds.x+145,end.y+end.height/2,{steps:25});await page.mouse.up();
      assert.equal(await page.getByText("Add to current chat",{exact:true}).count(), 0, "selection alone must not open a chat menu");
      // Monaco's own bulb: a content widget on the line, or a glyph-margin decoration when the line has no room.
      const bulb = page.locator('.monaco-editor .lightBulbWidget:visible, .monaco-editor .glyph-margin-widgets [class*="codicon-gutter-lightbulb"]:visible').first();
      await bulb.waitFor({timeout:5000});
      const place = await bulb.evaluate((node)=>{
        const editor = window.__selectionEditor = window.monaco.editor.getEditors().find((e)=>e.getDomNode()?.contains(node));
        const layout = editor.getLayoutInfo(), origin = editor.getDomNode().getBoundingClientRect(), box = node.getBoundingClientRect();
        const left = box.left - origin.left, right = box.right - origin.left;
        const overlaps = (start, width) => left < start + width && right > start;
        return { gutter: node.classList.contains("cgmr"), numbers: overlaps(layout.lineNumbersLeft, layout.lineNumbersWidth), folding: overlaps(layout.decorationsLeft, layout.decorationsWidth),
          left, right, margin: [layout.glyphMarginLeft, layout.glyphMarginLeft + layout.glyphMarginWidth], selection: editor.getSelection().toString() };
      });
      assert(!place.numbers && !place.folding, "lightbulb overlaps the line numbers or folding controls: "+JSON.stringify(place));
      if (place.gutter) {
        // Centred in a margin with room either side of it, not filling one lane flush against the
        // editor's edge — and wholly inside that margin.
        assert(place.margin[1] - place.margin[0] >= 2 * (place.right - place.left), "glyph margin has no room around the lightbulb: "+JSON.stringify(place));
        assert(Math.abs((place.left + place.right) / 2 - (place.margin[0] + place.margin[1]) / 2) <= 1, "gutter lightbulb is not centred: "+JSON.stringify(place));
        assert(place.right <= place.margin[1], "gutter lightbulb reaches past the glyph margin: "+JSON.stringify(place));
      }
      assert.equal((await lines.boundingBox()).y, y, "selection must not shift the editor");
      await page.screenshot({path:artifacts+"/"+device+"-lightbulb-"+(place.gutter?"gutter":"line")+".png",fullPage:true});
      // Right of the bulb's centre: Monaco hit-tests the gutter by x, so a bulb drawn over the line
      // numbers opens its menu from there and the same click selects the whole line.
      const size = await bulb.boundingBox();
      await bulb.click({position:{x:size.width/2+3,y:size.height/2}});
      assert.equal(await page.evaluate(()=>window.__selectionEditor.getSelection().toString()), place.selection, "clicking the lightbulb changed the selection");
      // Monaco's code-action menu, not a menu PPM draws.
      const menu = page.locator(".action-widget");
      await menu.getByText("Add to current chat",{exact:true}).waitFor({timeout:1000});
      await menu.getByText("Add to new chat",{exact:true}).waitFor();
      const cut = await menu.locator(".monaco-list-row.action .title").evaluateAll((titles)=>titles.filter((t)=>t.scrollWidth>t.clientWidth).map((t)=>t.textContent));
      assert.deepEqual(cut, [], "menu labels are cut off");
      assert.deepEqual(errors, []);
      await page.screenshot({path:artifacts+"/"+device+"-selection.png",fullPage:true});
      console.log("Monaco lightbulb menu offers both chats", device, place.gutter ? "(glyph margin)" : "(on the line)");
    };
    const chooseAction=async(name)=>{
      const option=page.getByText(name,{exact:true}),rect=await option.boundingBox();
      // Monaco blocks the opening click until the pointer moves into its menu.
      await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2,{steps:5});
      await option.click();
    };
    const draftBox=page.locator('textarea[placeholder="Ask anything..."]:visible').first();await draftBox.waitFor();await draftBox.fill("Keep my draft");
    // The page saves its own layout 1.5 s after a change; a PUT that lands before that save is
    // overwritten by it, and the reload then restores the chat instead of the editor.
    const showEditor=async()=>{await new Promise(r=>setTimeout(r,2500));await api(`/api/project/${name}/workspace`,{method:"PUT",body:JSON.stringify(workspace)});await page.reload();};
    await showEditor();
    if(process.env.PPM_SELECTION_REAL_FILE) await page.getByRole("button",{name:"Blame",exact:true}).click();
    await selectCode(...(process.env.PPM_SELECTION_REAL_FILE ? [14,20] : [0,1]));
    await chooseAction("Add to current chat");
    const box=page.locator('textarea[placeholder="Ask anything..."]:visible').first();await box.waitFor();
    assert.equal(await box.inputValue(),"Keep my draft");
    await box.fill("Explain selected code");await box.press("Enter");
    const historyPath=`/api/project/${name}/chat/sessions/${session.id}/messages?providerId=mock`;
    let sent;await until("selection delivered",async()=>{const history=await api(historyPath);sent=history.messages.find(m=>m.role==="user"&&m.content.includes(process.env.PPM_SELECTION_REAL_FILE ? 'Selected code from ' : "const answer = 42;"));return sent});
    assert(sent.content.includes("example.ts:"));assert(sent.content.includes("Explain selected code"));
    await until("response complete",async()=>await page.getByRole("button",{name:"Reply",exact:true}).count()>=2);
    if (process.env.PPM_SELECTION_REAL_FILE) await page.getByText("example.ts",{exact:true}).first().click();
    else await showEditor();
    await selectCode(...(process.env.PPM_SELECTION_REAL_FILE ? [14,20] : [4,4]));
    await chooseAction("Add to new chat");await box.waitFor();
    await page.getByText(/example.ts:\d/).last().waitFor();
    assert.equal(await box.inputValue(), "");
    const scripts=await page.locator("script[src]").evaluateAll(ns=>ns.map(n=>n.getAttribute("src")));assert(scripts.some(s=>s.startsWith("/assets/index-")));assert(!scripts.some(s=>s.includes("@vite/client")));
    const index=await readFile(resolve(dist,"web/index.html"),"utf8");for(const s of scripts.filter(s=>s.startsWith("/assets/index-")))assert(index.includes(s));
    assert.deepEqual(errors,[]);await page.screenshot({path:artifacts+"/"+device+".png",fullPage:true});
    results.push({device,passed:true,sessionId:session.id,selectedCodePrompt:sent.content,scripts});await context.close();
  }
  console.log(JSON.stringify({passed:true,origin,artifacts,results},null,2));
}catch(error){results.push({passed:false,error:String(error.stack)});process.exitCode=1;console.error(error);for(const c of browser?.contexts()??[])for(const p of c.pages())await p.screenshot({path:artifacts+"/failure.png",fullPage:true}).catch(()=>{});
}finally{await writeFile(artifacts+"/results.json",JSON.stringify({origin,artifacts,results},null,2));await writeFile(artifacts+"/server.log",serverLog);await browser?.close();child.kill("SIGTERM");}
