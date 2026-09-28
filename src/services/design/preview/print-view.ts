import type { DesignKind } from "../../../shared/design-types.ts";

/**
 * What the print view adds to a design page: page geometry, and a script that opens the
 * print dialog once the page (fonts included) has settled.
 *
 * Only a document served under a print-purpose token gets this, and that document is the
 * one design document whose CSP sandbox carries `allow-modals` — a canvas never does. A deck
 * prints one `section.slide` (or `[data-slide]`) per 1280x720 page with no margin; any other
 * design prints on the browser's paper size with a 12 mm margin. The rules are `!important`
 * because they are inserted before the page's own styles and must still win.
 *
 * `print()` can be refused without an exception (a browser ignoring modals in a sandboxed
 * document, or one that only prints from a user gesture), and nothing but `beforeprint` says
 * whether the dialog opened. When it did not, a banner asks for Ctrl/Cmd+P and offers a
 * button, whose click is a gesture. The banner never prints itself.
 */

const SLIDE_RULES = "@page{size:1280px 720px;margin:0}"
  + "html,body{margin:0!important;padding:0!important}"
  + "section.slide,[data-slide]{break-after:page!important;page-break-after:always!important;break-inside:avoid!important;margin:0!important;box-shadow:none!important}"
  + "section.slide:last-of-type,[data-slide]:last-of-type{break-after:auto!important;page-break-after:auto!important}";
const PAGE_RULES = "@page{margin:12mm}";
const COMMON_RULES = "html{-webkit-print-color-adjust:exact;print-color-adjust:exact}"
  + "#ppm-print-banner{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;gap:12px;align-items:center;"
  + "padding:10px 16px;border-radius:8px;background:#111827;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)}"
  + "#ppm-print-banner button{min-height:44px;padding:0 16px;border:0;border-radius:6px;background:#fff;color:#111827;font:inherit;cursor:pointer}"
  + "@media print{#ppm-print-banner{display:none!important}}";

// One constant, with no request-derived value in it; checked below like the bridge.
const PRINT_SCRIPT = `(function(){
var opened=false,started=false;
window.addEventListener("beforeprint",function(){opened=true;var b=document.getElementById("ppm-print-banner");if(b)b.remove();});
function banner(){
if(opened||document.getElementById("ppm-print-banner"))return;
var mac=/Mac|iPhone|iPad/.test(navigator.platform||navigator.userAgent);
var b=document.createElement("div");b.id="ppm-print-banner";b.setAttribute("role","alert");
var t=document.createElement("span");t.textContent="The print dialog did not open. Press "+(mac?"Cmd":"Ctrl")+"+P to save this as a PDF.";
var k=document.createElement("button");k.type="button";k.textContent="Print";k.onclick=function(){try{window.print();}catch(e){}};
b.appendChild(t);b.appendChild(k);(document.body||document.documentElement).appendChild(b);
}
function go(){
if(started)return;started=true;
setTimeout(function(){
try{window.print();}catch(e){}
setTimeout(banner,1000);
},300);
}
window.addEventListener("load",function(){
var f=document.fonts&&document.fonts.ready;
if(f)f.then(go,go);else go();
});
})();`;

if (/<\/script|<!--|<script/i.test(PRINT_SCRIPT)) {
  throw new Error("The print script contains a sequence that would break out of its <script> element");
}

export function printInjection(kind: DesignKind): string {
  const rules = (kind === "slides" ? SLIDE_RULES : PAGE_RULES) + COMMON_RULES;
  return `<style data-ppm-print="1">${rules}</style><script data-ppm-print="1">${PRINT_SCRIPT}</script>`;
}
