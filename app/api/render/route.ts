import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { renderSlide, urlToDataUrl, type RenderConfig } from "@/app/lib/render";
import { clientIp, rateLimit } from "@/app/lib/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 60;

type SlideInput = Omit<
  RenderConfig,
  "logoDataUrl" | "heroImageDataUrl" | "itemImageDataUrl" | "summaryEntries"
> & {
  logoUrl?: string | null;
  heroImageUrl?: string | null;
  itemImageUrl?: string | null;
  // Allow inline data: URLs already converted client-side too
  logoDataUrl?: string | null;
  heroImageDataUrl?: string | null;
  itemImageDataUrl?: string | null;
  // Summary slide: each entry carries a URL the server resolves into a data
  // URL alongside the other image fetches.
  summaryEntries?: Array<{
    rank: number | null;
    heading: string;
    imageUrl?: string | null;
    imageDataUrl?: string | null;
  }>;
};

type RenderBody = {
  slides: SlideInput[];
  format?: "zip" | "single";
  index?: number;
};

async function resolveImage(
  inlineDataUrl: string | null | undefined,
  url: string | null | undefined,
): Promise<string | null> {
  if (inlineDataUrl && inlineDataUrl.startsWith("data:")) return inlineDataUrl;
  if (url) return await urlToDataUrl(url);
  return null;
}

async function prepareSlide(s: SlideInput): Promise<RenderConfig> {
  // Resolve all images in parallel — logo/hero/item plus, for summary slides,
  // every entry's thumbnail. Up to ~12 fetches per summary, all in flight at
  // once, so total render time stays close to the slowest single fetch.
  const summaryEntriesPromise = s.summaryEntries
    ? Promise.all(
        s.summaryEntries.map(async (e) => ({
          rank: e.rank,
          heading: e.heading,
          imageDataUrl: await resolveImage(e.imageDataUrl, e.imageUrl),
        })),
      )
    : Promise.resolve(undefined);

  const [logo, hero, itemImg, summaryEntries] = await Promise.all([
    resolveImage(s.logoDataUrl, s.logoUrl),
    resolveImage(s.heroImageDataUrl, s.heroImageUrl),
    resolveImage(s.itemImageDataUrl, s.itemImageUrl),
    summaryEntriesPromise,
  ]);

  return {
    kind: s.kind,
    title: s.title,
    subtitle: s.subtitle,
    siteName: s.siteName,
    totalCount: s.totalCount,
    rank: s.rank,
    heading: s.heading,
    body: s.body,
    ctaText: s.ctaText,
    sourceUrl: s.sourceUrl,
    summaryStyle: s.summaryStyle,
    handle: s.handle,
    domainLabel: s.domainLabel,
    categoryLabel: s.categoryLabel,
    accentColor: s.accentColor,
    textColor: s.textColor,
    bgColor: s.bgColor,
    fontFamily: s.fontFamily,
    logoDataUrl: logo,
    heroImageDataUrl: hero,
    itemImageDataUrl: itemImg,
    summaryEntries,
    imagePosition: s.imagePosition ?? null,
  };
}

export async function POST(req: NextRequest) {
  // Render is CPU-heavy but cacheable. Higher cap than extract since the UI
  // calls it once per preview pass.
  const ip = clientIp(req.headers);
  const rl = rateLimit({ scope: "render", ip, max: 30, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
      },
    );
  }

  let body: RenderBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.slides || !Array.isArray(body.slides) || body.slides.length === 0) {
    return NextResponse.json({ error: "No slides supplied" }, { status: 400 });
  }

  try {
    if (body.format === "single") {
      const i = body.index ?? 0;
      const cfg = await prepareSlide(body.slides[i]);
      const png = await renderSlide(cfg);
      return new NextResponse(new Uint8Array(png), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Disposition": `inline; filename="slide-${i + 1}.png"`,
        },
      });
    }

    const zip = new JSZip();
    const configs = await Promise.all(body.slides.map(prepareSlide));
    const pngs = await Promise.all(configs.map((c) => renderSlide(c)));
    pngs.forEach((png, i) => {
      const num = String(i + 1).padStart(2, "0");
      zip.file(`slide-${num}.png`, png);
    });
    const zipBuf = await zip.generateAsync({ type: "nodebuffer" });
    return new NextResponse(new Uint8Array(zipBuf), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="instagram-carousel.zip"`,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Render failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
