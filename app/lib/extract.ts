import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { fetchHtml } from "./fetchHtml";
import { dominantAccentFromImage, fetchImageWithBytes } from "./extractColor";

export type Branding = {
  domain: string;
  siteName: string | null;
  logoUrl: string | null;
  logoDataUrl: string | null;
  faviconUrl: string | null;
  themeColor: string | null;
  accentColor: string | null;
  accentSource: "logo" | "theme-color" | "css" | "default";
  fontFamily: string | null;
};

export type ListItem = {
  rank: number | null;
  heading: string;
  body: string;
  imageUrl: string | null;
};

export type ExtractResult = {
  url: string;
  title: string;
  subtitle: string | null;
  heroImageUrl: string | null;
  items: ListItem[];
  branding: Branding;
};

export async function extractArticle(url: string): Promise<ExtractResult & { fetchedVia: "fetch" | "playwright" }> {
  const { html, via, status } = await fetchHtml(url);
  if (status >= 400) {
    throw new Error(`Page returned HTTP ${status}. Check the URL.`);
  }
  const $ = cheerio.load(html);
  const base = new URL(url);

  // Branding first — logo sniffing depends on <header> being present.
  const branding = extractBranding($, base);

  // Then strip page chrome so headings inside nav/footer never get picked up
  // as list items. Keep <article>-nested <header> (article hero) by scoping
  // the page-chrome strip to direct body children + role markers.
  $("body > nav, body > header, body > footer, body > aside").remove();
  $(
    "nav, aside, footer, [role='navigation'], [role='banner'], [role='contentinfo'], [role='complementary'], .site-nav, .navbar, .site-menu, .site-header, .site-footer, .sidebar, style, noscript",
  ).remove();
  // Strip scripts EXCEPT those nested inside gallery wrappers — Valnet's
  // gallery widget stores its per-entry image URLs inside an inline
  // <script type="module"> block, and the regex fallback in firstImageIn
  // needs that script content to survive.
  $("script").each((_, el) => {
    const $el = $(el);
    if ($el.closest('.valnet-gallery, .gallery, [class*="gallery"]').length) {
      return;
    }
    $el.remove();
  });

  const title = extractTitle($);
  const subtitle = extractSubtitle($);
  const heroImageUrl = extractHero($, base);
  const items = extractListItems($, base);

  // Pull the logo bytes once, derive the brand accent from it, and embed it
  // as a data URL so the renderer doesn't have to refetch (which would hit
  // the same Cloudflare friction we already navigated to get here).
  await enrichBrandingFromLogo(branding);

  return { url, title, subtitle, heroImageUrl, items, branding, fetchedVia: via };
}

async function enrichBrandingFromLogo(branding: Branding): Promise<void> {
  if (!branding.logoUrl) return;
  const img = await fetchImageWithBytes(branding.logoUrl);
  if (!img) return;
  branding.logoDataUrl = img.dataUrl;
  const sampled = await dominantAccentFromImage(img.buffer);
  if (sampled) {
    // Logo color wins over theme-color / CSS sniff. The user can still override
    // in the brand panel, but the auto-pick now matches "what the logo looks
    // like" rather than whatever <meta theme-color> happened to be set to.
    branding.accentColor = sampled;
    branding.accentSource = "logo";
  }
}

function abs(href: string | undefined, base: URL): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function extractTitle($: cheerio.CheerioAPI): string {
  const h1 = $("h1").first().text().trim();
  if (h1) return h1;
  const og = $('meta[property="og:title"]').attr("content")?.trim();
  if (og) return og;
  return $("title").text().trim() || "Untitled";
}

function extractSubtitle($: cheerio.CheerioAPI): string | null {
  const candidates = [
    $('meta[name="description"]').attr("content"),
    $('meta[property="og:description"]').attr("content"),
    $(".article-header__deck").text(),
    $(".deck").first().text(),
    $("h2.subtitle").first().text(),
  ];
  for (const c of candidates) {
    const v = c?.trim();
    if (v && v.length > 10) return v;
  }
  return null;
}

function extractHero($: cheerio.CheerioAPI, base: URL): string | null {
  const og = $('meta[property="og:image"]').attr("content");
  if (og) return abs(og, base);
  const twitter = $('meta[name="twitter:image"]').attr("content");
  if (twitter) return abs(twitter, base);
  const firstImg = $("article img, main img").first().attr("src");
  return abs(firstImg, base);
}

function extractBranding($: cheerio.CheerioAPI, base: URL): Branding {
  const siteName =
    $('meta[property="og:site_name"]').attr("content")?.trim() ||
    $('meta[name="application-name"]').attr("content")?.trim() ||
    base.hostname.replace(/^www\./, "");

  const themeColor =
    $('meta[name="theme-color"]').attr("content")?.trim() || null;

  // Prefer the on-page wordmark / header logo over apple-touch-icon, because
  // the on-page asset carries the brand's actual colors. Specific class names
  // and alt-text matches outrank generic "first img in header" — that catches
  // network/CMS icons (e.g. Valnet's master-brand mark) that sit above the
  // actual brand wordmark in the DOM.
  const siteHostStem = base.hostname
    .replace(/^www\./, "")
    .split(".")[0]
    .toLowerCase();
  const logoCandidates = [
    $('.header-logo img, [class*="site-logo"] img, [class*="brand-logo"] img')
      .first()
      .attr("src"),
    $(`img[alt*="${siteName}" i][alt*="logo" i]`).first().attr("src"),
    $('img[alt*="logo" i]').first().attr("src"),
    $('img[class*="logo" i]').first().attr("src"),
    $('a[class*="logo" i] img').first().attr("src"),
    $('header img').first().attr("src"),
    $('meta[property="og:logo"]').attr("content"),
    $('link[rel="apple-touch-icon"]').attr("href"),
    $('link[rel="apple-touch-icon-precomposed"]').attr("href"),
  ];
  // Reject candidates whose path looks like a parent/network mark rather than
  // the site's own brand. The site's logo asset usually carries the domain
  // stem (`tg-logo` for thegamer.com, `sr-logo` for screenrant.com).
  const logoUrl =
    logoCandidates
      .map((c) => abs(c, base))
      .find((c) => {
        if (!c) return false;
        const low = c.toLowerCase();
        if (siteHostStem && low.includes(`${siteHostStem}-logo`)) return true;
        if (siteHostStem && low.includes(`/${siteHostStem}`)) return true;
        // Filter generic network/CMS icons by name
        if (/valnet[-_]?(logo|icon|brand)/i.test(low)) return false;
        return true;
      }) ?? null;

  const faviconUrl =
    abs($('link[rel="icon"]').attr("href"), base) ||
    abs($('link[rel="shortcut icon"]').attr("href"), base) ||
    abs("/favicon.ico", base);

  const fontFamily = sniffFont($);

  // Accent: provisional — `enrichBrandingFromLogo()` later overrides this with
  // the actual dominant color sampled from the logo image, when one is found.
  const cssAccent = sniffAccent($);
  const accentColor = themeColor ?? cssAccent ?? null;
  const accentSource: Branding["accentSource"] = themeColor
    ? "theme-color"
    : cssAccent
      ? "css"
      : "default";

  return {
    domain: base.hostname,
    siteName,
    logoUrl,
    logoDataUrl: null,
    faviconUrl,
    themeColor,
    accentColor,
    accentSource,
    fontFamily,
  };
}

function sniffFont($: cheerio.CheerioAPI): string | null {
  // Look in <link href="fonts.googleapis.com/css?family=..."> first
  const gf = $('link[href*="fonts.googleapis.com"]').attr("href");
  if (gf) {
    const m = gf.match(/family=([^&:]+)/);
    if (m) return decodeURIComponent(m[1].replace(/\+/g, " "));
  }
  // Inline @font-face / body font-family
  const styleText = $("style").text();
  const m = styleText.match(/body\s*\{[^}]*font-family\s*:\s*([^;}]+)/i);
  if (m) {
    return m[1]
      .split(",")[0]
      .replace(/['"]/g, "")
      .trim();
  }
  return null;
}

function sniffAccent($: cheerio.CheerioAPI): string | null {
  const styleText = $("style").text();
  const m = styleText.match(
    /(?:--brand|--accent|--primary)[^:]*:\s*(#[0-9a-f]{3,8})/i,
  );
  return m ? m[1] : null;
}

/**
 * Listicle item extraction.
 *
 * Strategy in order of preference:
 *   1) Ranked h2 entries ("1. Title", "#5 Title") — most reliable signal.
 *   2) Unranked h2 entries — assumes entries are h2 and h3s are subsections
 *      inside each entry ("Pros", "Verdict", "Specs"). This is the common
 *      Valnet/Future/Hearst pattern.
 *   3) Ranked entries at any heading level — catches sites that tag entries
 *      as h3 inside an h2 section wrapper.
 *   4) Unranked h2+h3 mixed — only when neither (1)-(3) produces enough.
 *      Risk of double-counting subheads is highest here, so we also filter
 *      common subhead phrases.
 *   5) <ol>/<ul> items — last resort.
 */
function extractListItems(
  $: cheerio.CheerioAPI,
  base: URL,
): ListItem[] {
  const root = pickArticleRoot($);
  if (!root) return [];

  const h2 = collectHeadings($, root.find("h2").toArray());
  const h3 = collectHeadings($, root.find("h3").toArray());

  // Layer 1: ranked h2 (the strongest signal — entries explicitly numbered).
  if (h2.ranked.length >= 3) return buildItems($, h2.ranked, base);

  // Layer 2: unranked h2. If entries are h2 and subheads are h3, this avoids
  // pulling the subheads into the list.
  if (h2.unranked.length >= 4) {
    const items = h2.unranked.filter((h) => !looksLikeSubhead(h.clean));
    if (items.length >= 4) return buildItems($, withRanks(items), base);
  }

  // Layer 3: ranked anywhere — covers sites that tag entries as h3.
  const allRanked = [...h2.ranked, ...h3.ranked].sort((a, b) => a.rank - b.rank);
  if (allRanked.length >= 3) return buildItems($, allRanked, base);

  // Layer 4: mixed unranked. Strip subheads first.
  const mixed = [...h2.unranked, ...h3.unranked].filter(
    (h) => !looksLikeSubhead(h.clean),
  );
  if (mixed.length >= 4) return buildItems($, withRanks(mixed), base);

  // Fallback: ol/ul list
  const ol = root.find("ol li, ul li").toArray();
  if (ol.length >= 4) {
    return ol
      .map((el, i) => {
        const txt = $(el).text().trim().replace(/\s+/g, " ");
        if (!txt) return null;
        // First sentence as heading, rest as body
        const split = txt.match(/^(.{8,120}?[.!?])\s+(.+)$/);
        return {
          rank: i + 1,
          heading: split ? split[1] : txt.slice(0, 100),
          body: split ? split[2] : "",
          imageUrl: null,
        } as ListItem;
      })
      .filter((x): x is ListItem => !!x);
  }

  return [];
}

function pickArticleRoot($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode> | null {
  const candidates = [
    "article",
    "main article",
    '[itemprop="articleBody"]',
    ".article-body",
    ".entry-content",
    ".post-content",
    "main",
  ];
  for (const sel of candidates) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 200) return el;
  }
  return $("body").first().length ? $("body").first() : null;
}

function isJunkHeading(txt: string): boolean {
  const low = txt.toLowerCase();
  return /^(related|recommended|read (more|also|next)|about the author|sources?|see also|share this|advertisement|sign up|newsletter|trending|popular|table of contents|faqs?|frequently asked|q&a|comments?|methodology|how we (test|chose|picked|ranked))/i.test(
    low,
  );
}

/**
 * Heuristic for "this heading is a subsection inside an entry, not the entry
 * itself." Common in product roundups (Pros/Cons/Verdict) and Valnet listicles
 * ("Why we picked it", "What we like"). Short, often repeated across entries.
 *
 * Only used as a last-resort filter; the primary defense against subhead
 * pollution is preferring h2-only when there are enough h2s.
 */
function looksLikeSubhead(txt: string): boolean {
  const low = txt.toLowerCase().trim();
  if (low.length <= 30) {
    if (/^(pros|cons|specs?|verdict|features?|highlights?|conclusion|summary|overview|details?|key takeaways?|the (verdict|bottom line|good|bad|ugly)|what (we like|to know|to expect)|why (we (love|picked|chose|recommend) it|it works|it matters|buy)|how (to|it works)|where to buy|price|availability|design|performance|battery( life)?|camera|display|software|build quality|value for money)$/i.test(
      low,
    )) {
      return true;
    }
  }
  return false;
}

type Heading = { el: Element; clean: string; rank?: number };

function collectHeadings(
  $: cheerio.CheerioAPI,
  elements: Element[],
): { ranked: (Heading & { rank: number })[]; unranked: Heading[] } {
  const ranked: (Heading & { rank: number })[] = [];
  const unranked: Heading[] = [];
  for (const el of elements) {
    const txt = $(el).text().trim().replace(/\s+/g, " ");
    if (!txt || txt.length < 3) continue;
    if (isJunkHeading(txt)) continue;
    const rankMatch = txt.match(/^#?\s*(\d{1,3})\s*[.:)\-–]\s*(.+)$/);
    if (rankMatch) {
      ranked.push({
        el,
        rank: parseInt(rankMatch[1], 10),
        clean: rankMatch[2].trim(),
      });
    } else {
      unranked.push({ el, clean: txt });
    }
  }
  return { ranked, unranked };
}

function withRanks(headings: Heading[]): (Heading & { rank: number })[] {
  return headings.map((h, i) => ({ ...h, rank: h.rank ?? i + 1 }));
}

function buildItems(
  $: cheerio.CheerioAPI,
  headings: (Heading & { rank: number })[],
  base: URL,
): ListItem[] {
  return headings.map((h) => ({
    rank: h.rank,
    heading: h.clean,
    body: bodyAfter($, h.el),
    imageUrl: imageNear($, h.el, base),
  }));
}

const HEAD_LEVEL: Record<string, number> = {
  h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6,
};

/**
 * True if walking past `tag` would cross into the next entry — i.e. the tag
 * is a heading at the same level as the entry or shallower. Subheads (deeper
 * h-levels) are kept inside the current entry, so galleries and prose sitting
 * after an h3 sub-section heading still belong to the parent h2 entry.
 */
function isEntryBoundary(tag: string | undefined, entryTag: string): boolean {
  if (!tag) return false;
  const t = HEAD_LEVEL[tag];
  const e = HEAD_LEVEL[entryTag];
  if (t === undefined || e === undefined) return false;
  return t <= e;
}

function bodyAfter(
  $: cheerio.CheerioAPI,
  el: Element,
): string {
  const entryTag = (el as any).tagName?.toLowerCase?.() ?? "h2";
  const parts: string[] = [];
  let node: Element | null = el;
  let chars = 0;
  while (node) {
    const next: Element | undefined = (node as any).nextSibling;
    if (!next) break;
    node = next;
    const tag = (node as any).tagName?.toLowerCase?.();
    if (isEntryBoundary(tag, entryTag)) break;
    if (tag === "p" || tag === "div" || tag === "ul" || tag === "ol" || tag === "blockquote") {
      const t = $(node).text().trim().replace(/\s+/g, " ");
      if (t) {
        parts.push(t);
        chars += t.length;
        if (chars > 600) break;
      }
    }
  }
  return parts.join(" ").slice(0, 600);
}

function imageNear(
  $: cheerio.CheerioAPI,
  el: Element,
  base: URL,
): string | null {
  const entryTag = (el as any).tagName?.toLowerCase?.() ?? "h2";
  let node: Element | null = el;
  for (let i = 0; i < 60 && node; i++) {
    const next: Element | undefined = (node as any).nextSibling;
    if (!next) break;
    node = next;
    const tag = (node as any).tagName?.toLowerCase?.();
    if (isEntryBoundary(tag, entryTag)) break;
    if (!tag) continue; // text nodes between siblings
    const found = firstImageIn($, node, base);
    if (found) return found;
  }
  return null;
}

/**
 * Find the first usable image URL inside `scope`. Handles:
 *   - <img src> (basic)
 *   - lazy loading: data-src, data-lazy-src, data-original, data-srcset
 *   - <img srcset>: picks the first candidate
 *   - <picture><source srcset>
 *   - skips 1x1 pixels, blank placeholders, and data: URLs (low-info)
 *
 * Many Valnet articles wrap entry images in a `.valnet-gallery` div with
 * lazy-loaded <img> tags whose visible `src` is a tracking pixel. This helper
 * digs through to find the real URL.
 */
function firstImageIn(
  $: cheerio.CheerioAPI,
  scope: Element,
  base: URL,
): string | null {
  const $scope = $(scope);
  const isPlaceholder = (s: string) =>
    s.startsWith("data:") ||
    /\/(blank|pixel|placeholder|spacer|transparent)\.(gif|png|svg)/i.test(s);

  // Direct img on the scope element itself
  const own = $scope.is("img") ? scope : null;
  const imgs = own ? [own] : $scope.find("img").toArray();

  for (const img of imgs) {
    const $img = $(img);
    // Real-src attrs in priority order
    for (const attr of ["data-src", "data-lazy-src", "data-original", "src"]) {
      const v = $img.attr(attr);
      if (v && !isPlaceholder(v)) {
        return abs(v, base);
      }
    }
    // srcset fallbacks
    for (const attr of ["srcset", "data-srcset"]) {
      const ss = $img.attr(attr);
      if (ss) {
        const candidate = ss.split(",")[0]?.trim().split(/\s+/)[0];
        if (candidate && !isPlaceholder(candidate)) {
          return abs(candidate, base);
        }
      }
    }
  }

  // <picture><source srcset="..."> — used a lot on Cloudflare-fronted CDNs.
  const sources = $scope.find("source[srcset], source[data-srcset]").toArray();
  for (const s of sources) {
    const ss = $(s).attr("srcset") || $(s).attr("data-srcset");
    if (ss) {
      const candidate = ss.split(",")[0]?.trim().split(/\s+/)[0];
      if (candidate && !isPlaceholder(candidate)) {
        return abs(candidate, base);
      }
    }
  }

  // Last resort: pull a URL out of the raw HTML. Valnet's gallery widget
  // (`.valnet-gallery`) injects images via a JS bootstrap — the real URLs
  // sit inside a `<script>` block as an HTML-encoded string with backslash-
  // escaped slashes:
  //
  //   window.arrayOfGalleries["..."] = '&lt;picture&gt;...data-img-url=\&quot;https:\/\/static0.../foo.jpg\&quot;...'
  //
  // Since every slash inside the URL is escaped as `\/`, we have to keep
  // backslashes IN the matched URL — then unescape them. Stops at `.jpg`/
  // `.png`/`.webp` so we capture the base asset, not the resized variant.
  const raw = $scope.html() ?? "";
  if (raw.length > 0) {
    const match = raw.match(
      /https?:(?:\\?\/){2}[^\s"'<>&]+?\.(?:jpe?g|png|webp)/i,
    );
    if (match) {
      const cleaned = match[0].replace(/\\\//g, "/");
      if (!isPlaceholder(cleaned)) return abs(cleaned, base);
    }
  }

  return null;
}
