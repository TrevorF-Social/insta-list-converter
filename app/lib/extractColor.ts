import sharp from "sharp";

/**
 * Pulls a dominant brand color from a logo image. Resizes to 64×64 to suppress
 * noise, then buckets pixels in 4-bits-per-channel cells and picks the cell
 * with the highest weighted vote, biased toward saturated mid-tones.
 *
 * We deliberately skip:
 *   - Transparent pixels (logos often sit on transparent bg)
 *   - Near-grey pixels (chrome, drop shadows, anti-aliasing fringe)
 *   - Near-black and near-white (the most common "fill" colors that aren't
 *     the brand color — e.g. the "SCREEN" half of the ScreenRant SR mark)
 *
 * Returns a hex color or null if the logo has no clear brand color (which is
 * fine — the caller falls back to whatever the site's CSS yielded).
 */
export async function dominantAccentFromImage(
  buffer: Buffer,
): Promise<string | null> {
  try {
    const { data, info } = await sharp(buffer)
      .resize(64, 64, { fit: "inside", withoutEnlargement: false })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const ch = info.channels;
    const buckets = new Map<string, { count: number; r: number; g: number; b: number; weight: number }>();

    for (let i = 0; i < data.length; i += ch) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = ch === 4 ? data[i + 3] : 255;
      if (a < 200) continue;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max < 40) continue; // near-black
      if (min > 235) continue; // near-white
      const sat = max === 0 ? 0 : (max - min) / max;
      if (sat < 0.35) continue;

      // Light = max/255. Favor mid-tone saturated colors over pastels or neons.
      const light = max / 255;
      const weight = sat * (1 - Math.abs(light - 0.55));

      const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
      const cur = buckets.get(key);
      if (cur) {
        cur.count += 1;
        cur.weight += weight;
        cur.r += r;
        cur.g += g;
        cur.b += b;
      } else {
        buckets.set(key, { count: 1, weight, r, g, b });
      }
    }

    if (buckets.size === 0) return null;

    let best: { count: number; r: number; g: number; b: number; weight: number } | null = null;
    for (const v of buckets.values()) {
      if (!best || v.weight > best.weight) best = v;
    }
    if (!best) return null;

    const r = Math.round(best.r / best.count);
    const g = Math.round(best.g / best.count);
    const b = Math.round(best.b / best.count);
    return (
      "#" +
      [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")
    );
  } catch {
    return null;
  }
}

/**
 * Fetches an image URL using the same browser-shaped headers as the slide
 * renderer, so Cloudflare-protected logos resolve. Returns both the raw bytes
 * (for color analysis) and a data URL (for embedding in the rendered slide
 * without a second fetch).
 */
export async function fetchImageWithBytes(
  url: string,
): Promise<{ buffer: Buffer; dataUrl: string } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        // Accept anything; sharp transcodes AVIF/WebP/SVG below.
        Accept:
          "image/png,image/jpeg,image/webp,image/avif,image/svg+xml,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: new URL(url).origin + "/",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const raw = Buffer.from(await res.arrayBuffer());
    const ctype =
      res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";

    // SVG / AVIF / WebP all need transcoding before satori can render them.
    // sharp reads every one and outputs PNG — that also gives the color
    // sampler real pixel data to work with.
    if (
      ctype === "image/svg+xml" ||
      ctype === "image/svg" ||
      ctype === "image/avif" ||
      ctype === "image/webp"
    ) {
      const png = await sharp(raw, { density: 300 })
        .resize(512, 512, { fit: "inside", withoutEnlargement: false })
        .png()
        .toBuffer();
      return {
        buffer: png,
        dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      };
    }

    return {
      buffer: raw,
      dataUrl: `data:${ctype};base64,${raw.toString("base64")}`,
    };
  } catch {
    return null;
  }
}
