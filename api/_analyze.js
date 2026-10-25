/* Analyse d'un site : récupère la page et ses feuilles de style, puis en extrait
   couleurs, polices et indices d'animation. Aucune exécution de JavaScript.
   Protégée contre le SSRF : seules les adresses publiques en http/https (ports 80/443) sont jointes,
   y compris après redirection, et la résolution DNS est contrôlée au moment de la connexion. */
const http = require("http");
const https = require("https");
const dns = require("dns");
const net = require("net");
const zlib = require("zlib");

const TIMEOUT_MS = 6000;
const MAX_HTML = 1000000;
const MAX_CSS = 600000;
const MAX_REDIRECTS = 3;

function privateV4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) || (a === 198 && (b === 18 || b === 19));
}
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return privateV4(ip);
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return privateV4(m[1]);
    if (l === "::" || l === "::1") return true;
    if (/^f[cd]/.test(l) || /^fe[89ab]/.test(l) || /^ff/.test(l)) return true;
    return false;
  }
  return true;
}
function makeLookup(allowPrivate) {
  return function (hostname, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!addrs.length || (!allowPrivate && addrs.some((a) => isPrivateIp(a.address)))) return cb(new Error("adresse refusée"));
      if (opts && opts.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

function fetchText(urlStr, maxBytes, opts, redirects) {
  opts = opts || {}; redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error("URL invalide")); }
    if (u.protocol !== "http:" && u.protocol !== "https:") return reject(new Error("protocole refusé"));
    if (u.username || u.password) return reject(new Error("URL refusée"));
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    if (!opts.allowPrivate && port !== "80" && port !== "443") return reject(new Error("port refusé"));
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (!opts.allowPrivate && net.isIP(host) && isPrivateIp(host)) return reject(new Error("adresse refusée"));
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, {
      method: "GET",
      lookup: makeLookup(!!opts.allowPrivate),
      timeout: TIMEOUT_MS,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; GlowStyleBot/1.0)",
        accept: "text/html,text/css,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "accept-language": "fr,en;q=0.8",
        "accept-encoding": "gzip, deflate, br",
      },
    }, (res) => {
      const sc = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(sc) && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error("trop de redirections"));
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch (e) { return reject(new Error("redirection invalide")); }
        return fetchText(next, maxBytes, opts, redirects + 1).then(resolve, reject);
      }
      if (sc < 200 || sc >= 300) { res.resume(); return reject(new Error("HTTP " + sc)); }
      const ct = String(res.headers["content-type"] || "").toLowerCase();
      if (ct && !/text\/|xml|json|javascript/.test(ct)) { res.resume(); return reject(new Error("type refusé")); }
      let stream = res;
      const enc = String(res.headers["content-encoding"] || "").toLowerCase();
      if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = []; let size = 0, done = false;
      const finish = () => { if (done) return; done = true; resolve({ text: Buffer.concat(chunks).toString("utf8"), url: u.toString() }); };
      stream.on("data", (c) => {
        if (done) return;
        size += c.length; chunks.push(c);
        if (size >= maxBytes) { finish(); try { req.destroy(); } catch (e) {} }
      });
      stream.on("end", finish);
      stream.on("error", () => (size ? finish() : reject(new Error("lecture impossible"))));
    });
    req.on("timeout", () => req.destroy(new Error("délai dépassé")));
    req.on("error", (e) => reject(e));
    req.end();
  });
}

/* ---------- Extraction ---------- */
const clean = (s, n) => String(s).replace(/[^\p{L}\p{N} ._+\-]/gu, "").trim().slice(0, n || 40);
function toHex(r, g, b) { return "#" + [r, g, b].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0")).join("").toUpperCase(); }
function normHex(h) {
  h = h.replace("#", "");
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
  else if (h.length === 8) h = h.slice(0, 6);
  else if (h.length !== 6) return null;
  return "#" + h.toUpperCase();
}
function hsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  return { s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l };
}
function top(map, n) { return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n); }
function bump(map, k, by) { map.set(k, (map.get(k) || 0) + (by || 1)); }

function analyzeSources(html, cssTexts, baseUrl) {
  const css = cssTexts.join("\n") + "\n" + (html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []).join("\n");
  const all = css + "\n" + (html.match(/style="[^"]*"/gi) || []).join("\n");
  const colors = new Map();
  let m;
  const hexRe = /#([0-9a-fA-F]{3,8})\b/g;
  while ((m = hexRe.exec(all))) { const h = normHex(m[0]); if (h) bump(colors, h); }
  const rgbRe = /rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/g;
  while ((m = rgbRe.exec(all))) bump(colors, toHex(+m[1], +m[2], +m[3]));
  const vivid = [], neutral = [];
  for (const [h, c] of top(colors, 60)) {
    const { s, l } = hsl(h);
    (s > 0.25 && l > 0.1 && l < 0.92 ? vivid : neutral).push([h, c]);
  }
  const vars = []; const varRe = /--([a-zA-Z0-9_-]{1,32})\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]{5,30}\))/g;
  const seenVar = new Set();
  while ((m = varRe.exec(css)) && vars.length < 14) {
    let h = m[2].startsWith("#") ? normHex(m[2]) : (() => { const x = m[2].match(/(\d+)\D+(\d+)\D+(\d+)/); return x ? toHex(+x[1], +x[2], +x[3]) : null; })();
    const k = clean(m[1], 32) + h;
    if (h && !seenVar.has(k)) { seenVar.add(k); vars.push([clean(m[1], 32), h]); }
  }
  let bodyBg = "", bodyColor = "";
  const rootRe = /(?:^|[}\s,])(?:html|body|:root)[^{}]*\{([^}]*)\}/g;
  while ((m = rootRe.exec(css))) {
    const bg = m[1].match(/background(?:-color)?\s*:\s*([^;}]+)/i), fg = m[1].match(/(?:^|;|\s)color\s*:\s*([^;}]+)/i);
    if (bg && !bodyBg) bodyBg = clean(bg[1], 50);
    if (fg && !bodyColor) bodyColor = clean(fg[1], 50);
  }
  const GEN = /^(sans-serif|serif|monospace|system-ui|-apple-system|blinkmacsystemfont|segoe ui|arial|helvetica|helvetica neue|ui-[a-z-]+|inherit|initial|unset|cursive|fantasy|emoji|math|var\(.*|"?apple color emoji"?|"?segoe ui emoji"?|"?noto color emoji"?)$/i;
  const fonts = new Map();
  const ffRe = /font-family\s*:\s*([^;{}]+)/gi;
  while ((m = ffRe.exec(css))) m[1].split(",").forEach((f, i) => { f = f.trim().replace(/^["']|["']$/g, ""); if (f && !GEN.test(f)) bump(fonts, clean(f, 40), i === 0 ? 3 : 1); });
  const gf = [];
  const gfRe = /fonts\.googleapis\.com\/css2?\?([^"'\s>)]+)/g;
  while ((m = gfRe.exec(html + css))) {
    decodeURIComponent(m[1].replace(/&amp;/g, "&").replace(/\+/g, " ")).split("&").filter((p) => p.startsWith("family=")).forEach((p) => gf.push(clean(p.slice(7).split(":")[0], 40)));
  }
  const faces = []; const faceRe = /@font-face\s*\{[^}]*font-family\s*:\s*["']?([^;"'}]+)/gi;
  while ((m = faceRe.exec(css)) && faces.length < 6) faces.push(clean(m[1], 40));
  const kf = []; const kfRe = /@keyframes\s+([\w-]{1,40})/g;
  while ((m = kfRe.exec(css)) && kf.length < 12) if (!kf.includes(m[1])) kf.push(clean(m[1], 40));
  const durs = new Map(), eases = new Map();
  const trRe = /(?:transition|animation)(?:-duration|-timing-function)?\s*:\s*([^;}{]+)/gi;
  while ((m = trRe.exec(css))) {
    (m[1].match(/(?<![\w.])\d*\.?\d+m?s\b/g) || []).forEach((d) => bump(durs, d));
    (m[1].match(/cubic-bezier\([^)]{5,40}\)/g) || []).forEach((e) => bump(eases, e.replace(/\s+/g, "")));
    (m[1].match(/\b(ease-in-out|ease-out|ease-in|ease|linear)\b/g) || []).forEach((e) => bump(eases, e));
  }
  const radius = new Map(); const rdRe = /border-radius\s*:\s*([^;}{]{1,30})/gi;
  while ((m = rdRe.exec(css))) bump(radius, clean(m[1], 30));
  const hay = (html + " " + baseUrl).toLowerCase();
  const libs = [];
  [["gsap", "GSAP"], ["framer", "Framer / Framer Motion"], ["lottie", "Lottie"], ["three.js", "Three.js (3D)"], ["three.module", "Three.js (3D)"], ["lenis", "Lenis (scroll fluide)"], ["locomotive", "Locomotive Scroll"], ["anime.js", "Anime.js"], ["swiper", "Swiper"], ["data-wf-", "Webflow"], ["_next/", "Next.js"], ["wp-content", "WordPress"], ["scrollmagic", "ScrollMagic"], ["aos.js", "AOS"], ["typekit", "Adobe Fonts"]]
    .forEach(([k, n]) => { if (hay.includes(k) && !libs.includes(n)) libs.push(n); });
  const title = clean((html.match(/<title[^>]*>([^<]{1,200})/i) || [])[1] || "", 100);
  const theme = (html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']{1,20})/i) || [])[1];
  const cssBytes = css.length;
  return {
    title, theme: theme && /^#[0-9a-f]{3,8}$/i.test(theme.trim()) ? theme.trim().toUpperCase() : "", cssBytes,
    vivid: vivid.slice(0, 6), neutral: neutral.slice(0, 5), vars, bodyBg, bodyColor,
    fonts: top(fonts, 6).map((x) => x[0]), googleFonts: [...new Set(gf)].slice(0, 6), faces: [...new Set(faces)],
    keyframes: kf, durations: top(durs, 4).map((x) => x[0]), easings: top(eases, 4).map((x) => x[0]),
    radius: top(radius, 3).map((x) => x[0]), libs,
  };
}

function summarize(a, host) {
  const L = [];
  L.push("Site : " + host + (a.title ? " (titre : " + a.title + ")" : ""));
  if (a.theme) L.push("Couleur de thème déclarée : " + a.theme);
  if (a.bodyBg || a.bodyColor) L.push("Fond / texte de la page : " + (a.bodyBg || "?") + " / " + (a.bodyColor || "?"));
  if (a.vivid.length) L.push("Couleurs vives les plus utilisées : " + a.vivid.map((x) => x[0] + " (" + x[1] + "x)").join(", "));
  if (a.neutral.length) L.push("Neutres les plus utilisés : " + a.neutral.map((x) => x[0] + " (" + x[1] + "x)").join(", "));
  if (a.vars.length) L.push("Variables CSS de couleur : " + a.vars.map((x) => x[0] + "=" + x[1]).join(", "));
  const fonts = [...new Set([...a.googleFonts, ...a.faces, ...a.fonts])];
  if (fonts.length) L.push("Polices : " + fonts.join(", "));
  if (a.radius.length) L.push("Arrondis fréquents : " + a.radius.join(" ; "));
  if (a.keyframes.length) L.push("Animations CSS (@keyframes) : " + a.keyframes.join(", "));
  if (a.durations.length) L.push("Durées de transition/animation fréquentes : " + a.durations.join(", "));
  if (a.easings.length) L.push("Courbes d'accélération fréquentes : " + a.easings.join(", "));
  if (a.libs.length) L.push("Indices techniques : " + a.libs.join(", "));
  if (a.cssBytes < 4000) L.push("ATTENTION : très peu de CSS accessible (site probablement rendu en JavaScript) : l'analyse est partielle.");
  L.push("Limites : extraction automatique du code CSS, sans exécuter la page. Les couleurs les plus fréquentes ne sont pas toujours celles de la marque. Les animations déclenchées par JavaScript ne sont pas visibles.");
  return L.join("\n").slice(0, 2600);
}

function extractUrls(text) {
  const out = [];
  const re = /\b((?:https?:\/\/)?(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|fr|io|co|net|org|app|dev|ai|studio|design|agency|me|tv|xyz|site|tech|media|digital|shop|store|eu|uk|us|ca|de|es|it)(?::\d+)?(?:\/[^\s<>"')]*)?)/gi;
  let m;
  while ((m = re.exec(text)) && out.length < 4) {
    let u = m[1].replace(/[.,;:!?]+$/, "");
    if (!/^https?:\/\//i.test(u)) { if (/@/.test(text.slice(Math.max(0, m.index - 1), m.index))) continue; u = "https://" + u; }
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

async function analyzeUrl(urlStr, opts) {
  opts = opts || {};
  let host = "";
  try { host = new URL(urlStr).hostname; } catch (e) { return { url: urlStr, ok: false, error: "Adresse invalide." }; }
  try {
    const page = await fetchText(urlStr, MAX_HTML, opts);
    const html = page.text;
    const base = page.url;
    const hrefs = [];
    const linkRe = /<link\b[^>]*>/gi; let m;
    while ((m = linkRe.exec(html))) {
      if (/rel=["']?stylesheet/i.test(m[0])) { const h = m[0].match(/href=["']([^"']+)["']/i); if (h) hrefs.push(h[1]); }
    }
    const cssUrls = [];
    for (const h of hrefs) {
      if (/fonts\.googleapis\.com/.test(h)) continue;
      try { const abs = new URL(h.replace(/&amp;/g, "&"), base).toString(); if (!cssUrls.includes(abs)) cssUrls.push(abs); } catch (e) {}
      if (cssUrls.length >= 4) break;
    }
    const cssTexts = (await Promise.all(cssUrls.map((u) => fetchText(u, MAX_CSS, opts).then((r) => r.text).catch(() => "")))).filter(Boolean);
    const a = analyzeSources(html, cssTexts, base);
    const colors = [...a.vivid.map((x) => x[0]), ...a.neutral.slice(0, 3).map((x) => x[0])];
    const fonts = [...new Set([...a.googleFonts, ...a.faces, ...a.fonts])].slice(0, 5);
    const nothing = !colors.length && !fonts.length;
    return { url: urlStr, host, ok: !nothing, summary: summarize(a, host), colors, fonts, partial: a.cssBytes < 4000, error: nothing ? "Presque rien d'exploitable sur cette page." : undefined };
  } catch (e) {
    return { url: urlStr, host, ok: false, error: "Site inaccessible ou refusé (" + clean(e && e.message, 40) + ")." };
  }
}

module.exports = { analyzeUrl, extractUrls, analyzeSources, summarize, fetchText, isPrivateIp };
