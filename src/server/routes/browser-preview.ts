import { Hono } from "hono";

/**
 * Browser preview reverse proxy — forwards requests to localhost:<port>.
 * Mounted at /api/preview/:port/* so the frontend iframe can load
 * any localhost dev server through PPM's own origin (avoiding CORS/framing issues).
 *
 * HTML responses are rewritten to remap absolute paths (src="/...", href="/...")
 * through the proxy prefix so assets, scripts, and stylesheets load correctly.
 */
export const browserPreviewRoutes = new Hono();

/** Only allow proxying to localhost ports (security: prevent SSRF) */
function isValidPort(port: string): boolean {
  const n = parseInt(port, 10);
  return !isNaN(n) && n >= 1 && n <= 65535;
}

/** Rewrite absolute paths in HTML so they route through the proxy */
function rewriteHtml(html: string, proxyBase: string): string {
  // Rewrite src="/...", href="/...", action="/...", from="/...", poster="/..."
  // But skip src="//..." (protocol-relative) and href="https://..." etc.
  let result = html.replace(
    /((?:src|href|action|from|poster|content)\s*=\s*["'])\/(?!\/)/gi,
    `$1${proxyBase}/`,
  );

  // Rewrite url("/...") in inline styles and <style> blocks
  result = result.replace(
    /(url\(\s*["']?)\/(?!\/)/gi,
    `$1${proxyBase}/`,
  );

  // Rewrite fetch("/...") and import("/...") in inline scripts
  result = result.replace(
    /((?:fetch|import)\s*\(\s*["'])\/(?!\/)/gi,
    `$1${proxyBase}/`,
  );

  // Inject <script> to override fetch/XHR/WebSocket for runtime JS requests
  const runtimePatch = `<script data-ppm-proxy>
(function(){
  var B="${proxyBase}";
  // Patch fetch
  var _f=window.fetch;
  window.fetch=function(u,o){
    if(typeof u==="string"&&u.startsWith("/")&&!u.startsWith(B+"/"))u=B+u;
    else if(u instanceof Request&&u.url){
      try{var p=new URL(u.url).pathname;if(p.startsWith("/")&&!p.startsWith(B+"/"))u=new Request(B+p+new URL(u.url).search,u);}catch(e){}
    }
    return _f.call(this,u,o);
  };
  // Patch XMLHttpRequest
  var _o=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    if(typeof u==="string"&&u.startsWith("/")&&!u.startsWith(B+"/"))u=B+u;
    return _o.apply(this,[m,u].concat([].slice.call(arguments,2)));
  };
  // Patch WebSocket for HMR (Vite, webpack, etc.)
  var _W=window.WebSocket;
  window.WebSocket=function(u,p){
    try{
      var url=new URL(u);
      if(url.hostname==="localhost"||url.hostname==="127.0.0.1"||url.hostname==="0.0.0.0"){
        // Connect directly to the dev server's WebSocket (same host as PPM)
        url.host=location.host;
        u=url.toString();
      }
    }catch(e){}
    return p!==undefined?new _W(u,p):new _W(u);
  };
  window.WebSocket.prototype=_W.prototype;
  window.WebSocket.CONNECTING=_W.CONNECTING;
  window.WebSocket.OPEN=_W.OPEN;
  window.WebSocket.CLOSING=_W.CLOSING;
  window.WebSocket.CLOSED=_W.CLOSED;
})();
</script>`;

  // Inject right after <head> or at start of HTML
  if (result.includes("<head>")) {
    result = result.replace("<head>", "<head>" + runtimePatch);
  } else if (result.includes("<head ")) {
    result = result.replace(/<head\s[^>]*>/, "$&" + runtimePatch);
  } else if (result.includes("<html")) {
    result = result.replace(/<html[^>]*>/, "$&" + runtimePatch);
  } else {
    result = runtimePatch + result;
  }

  return result;
}

/** Rewrite absolute import paths in JS/TS module responses */
function rewriteJs(js: string, proxyBase: string): string {
  // Static imports: import ... from "/...", import "/..."
  let result = js.replace(
    /((?:from|import)\s*["'])\/(?!\/)/g,
    `$1${proxyBase}/`,
  );

  // Dynamic imports: import("/..."), import('/...')
  result = result.replace(
    /(import\s*\(\s*["'])\/(?!\/)/g,
    `$1${proxyBase}/`,
  );

  // Vite-specific: new URL("/...", import.meta.url)
  result = result.replace(
    /(new\s+URL\(\s*["'])\/(?!\/)/g,
    `$1${proxyBase}/`,
  );

  return result;
}

/** Rewrite absolute paths in CSS responses */
function rewriteCss(css: string, proxyBase: string): string {
  // url("/...") and url('/...') and url(/...)
  let result = css.replace(
    /(url\(\s*["']?)\/(?!\/)/g,
    `$1${proxyBase}/`,
  );
  // @import "/..."
  result = result.replace(
    /(@import\s+["'])\/(?!\/)/g,
    `$1${proxyBase}/`,
  );
  return result;
}

/** Detect response content type */
function getResponseType(resp: Response, path: string): "html" | "js" | "css" | "other" {
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("text/html")) return "html";
  if (ct.includes("text/css")) return "css";
  if (ct.includes("javascript") || ct.includes("typescript") || ct.includes("text/jsx")) return "js";
  // Vite serves .ts/.tsx/.jsx with application/javascript or sometimes no content-type
  // Fall back to extension detection for module files
  const ext = path.split("?")[0]?.split(".").pop()?.toLowerCase();
  if (ext && ["js", "mjs", "jsx", "ts", "tsx", "mts"].includes(ext)) return "js";
  return "other";
}

/** Shared proxy handler */
async function proxyRequest(c: any, port: string, targetPath: string) {
  const url = new URL(c.req.url);
  const targetUrl = `http://localhost:${port}${targetPath}${url.search}`;
  const proxyBase = `/api/preview/${port}`;

  try {
    const headers = new Headers(c.req.raw.headers);
    headers.delete("host");
    // Set correct referer for the target
    headers.set("referer", `http://localhost:${port}${targetPath}`);

    const resp = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
      redirect: "manual",
    });

    const respHeaders = new Headers(resp.headers);
    respHeaders.delete("x-frame-options");
    respHeaders.delete("content-security-policy");

    // Rewrite Location header for redirects
    const location = respHeaders.get("location");
    if (location?.startsWith("/")) {
      respHeaders.set("location", `${proxyBase}${location}`);
    }

    // Rewrite text responses to fix absolute paths
    const rtype = getResponseType(resp, targetPath);
    if (rtype !== "other" && resp.body) {
      const text = await resp.text();
      let rewritten: string;
      if (rtype === "html") rewritten = rewriteHtml(text, proxyBase);
      else if (rtype === "js") rewritten = rewriteJs(text, proxyBase);
      else rewritten = rewriteCss(text, proxyBase);

      respHeaders.delete("content-length");
      return new Response(rewritten, {
        status: resp.status,
        statusText: resp.statusText,
        headers: respHeaders,
      });
    }

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
    });
  } catch {
    return c.text(`Cannot connect to localhost:${port}`, 502);
  }
}

browserPreviewRoutes.all("/:port{[0-9]+}/*", async (c) => {
  const port = c.req.param("port");
  if (!isValidPort(port)) return c.text("Invalid port", 400);

  const prefix = `/api/preview/${port}`;
  const url = new URL(c.req.url);
  const targetPath = url.pathname.slice(prefix.length) || "/";
  return proxyRequest(c, port, targetPath);
});

browserPreviewRoutes.all("/:port{[0-9]+}", async (c) => {
  const port = c.req.param("port");
  if (!isValidPort(port)) return c.text("Invalid port", 400);
  return proxyRequest(c, port, "/");
});
