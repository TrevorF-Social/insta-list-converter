"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  ExtractResult,
  BrandConfig,
  ListItem,
  ImagePosition,
  SummaryStyle,
} from "./types";
import { generateFacebookCopy } from "./lib/ai/social-copy";

const DEFAULT_POSITION: ImagePosition = { x: 50, y: 50 };
const ANTHROPIC_KEY_STORAGE = "anthropic-api-key";

/**
 * Per-publisher summary-style preferences. GameRant uses the hero-overlay
 * layout (full-bleed photo + white pill cards); everyone else gets the
 * default ranked layout. Users can still override per-article in the UI.
 */
function defaultSummaryStyleFor(domain: string | null | undefined): SummaryStyle {
  if (!domain) return "ranked";
  if (/(^|\.)gamerant\.com$/i.test(domain)) return "hero-overlay";
  if (/(^|\.)thegamer\.com$/i.test(domain)) return "ranked-overlay";
  return "ranked";
}

/**
 * Whether to reverse the list by default for this publisher. TheGamer
 * structures most ranking articles as countdowns (#10 listed first, #1
 * last) — extracting in DOM order would otherwise put their #10 at the
 * top of the summary. Users can still flip the toggle per-article.
 */
function defaultReverseOrderFor(domain: string | null | undefined): boolean {
  if (!domain) return false;
  if (/(^|\.)thegamer\.com$/i.test(domain)) return true;
  return false;
}

const DEFAULT_BG = "#0b0b0c";
const DEFAULT_TEXT = "#ffffff";
const DEFAULT_ACCENT = "#e11d48";

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<ExtractResult | null>(null);
  const [title, setTitle] = useState("");
  const [items, setItems] = useState<ListItem[]>([]);
  const [brand, setBrand] = useState<BrandConfig>({
    siteName: "",
    accentColor: DEFAULT_ACCENT,
    bgColor: DEFAULT_BG,
    textColor: DEFAULT_TEXT,
    fontFamily: "Inter",
    logoDataUrl: null,
    logoUrl: null,
  });
  const [coverPosition, setCoverPosition] = useState<ImagePosition>(DEFAULT_POSITION);
  const [includeSummary, setIncludeSummary] = useState(true);
  const [summaryStyle, setSummaryStyle] = useState<SummaryStyle>("ranked");
  // When true, items + summary entries render in DOM-reverse order with
  // ranks re-numbered 1..N. Default ON for TheGamer-style countdown articles.
  const [reverseListOrder, setReverseListOrder] = useState(false);
  // Hero-overlay summary: which image fills the backdrop, plus focal point.
  // "article" = article hero, "entry-N" = items[N].imageUrl, "custom" = uploaded.
  const [summaryHeroChoice, setSummaryHeroChoice] = useState<string>("article");
  const [summaryCustomHero, setSummaryCustomHero] = useState<string | null>(null);
  const [summaryHeroPosition, setSummaryHeroPosition] = useState<ImagePosition>(DEFAULT_POSITION);
  const [previews, setPreviews] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Facebook copy generator state
  const [fbVariants, setFbVariants] = useState<string[]>([]);
  const [fbLoading, setFbLoading] = useState(false);
  const [fbError, setFbError] = useState<string | null>(null);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [rememberKey, setRememberKey] = useState(false);

  useEffect(() => {
    // localStorage isn't available during SSR — guard on window.
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(ANTHROPIC_KEY_STORAGE);
    if (saved) {
      setAnthropicKey(saved);
      setRememberKey(true);
    }
  }, []);

  async function handleExtract(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    setExtracted(null);
    setPreviews([]);
    setCoverPosition(DEFAULT_POSITION);
    // Re-extracting an article wipes any previous summary-hero selection so
    // we don't end up pointing at an entry index that no longer exists.
    setSummaryHeroChoice("article");
    setSummaryCustomHero(null);
    setSummaryHeroPosition(DEFAULT_POSITION);
    try {
      const r = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Extraction failed");
      const result = data as ExtractResult;
      setExtracted(result);
      setTitle(result.title);
      setItems(result.items);
      setBrand({
        siteName: result.branding.siteName ?? result.branding.domain,
        accentColor: result.branding.accentColor ?? DEFAULT_ACCENT,
        bgColor: DEFAULT_BG,
        textColor: DEFAULT_TEXT,
        fontFamily: result.branding.fontFamily ?? "Inter",
        // Logo bytes are returned pre-fetched from /api/extract so we don't
        // have to re-resolve a CDN-fronted URL at render time.
        logoDataUrl: result.branding.logoDataUrl,
        logoUrl: result.branding.logoUrl,
      });
      // Pick a summary layout based on the source publisher. The user can
      // still override below, but this lands them on the "right" default.
      setSummaryStyle(defaultSummaryStyleFor(result.branding.domain));
      setReverseListOrder(defaultReverseOrderFor(result.branding.domain));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  // Source of the summary slide's backdrop image, derived from the user's
  // dropdown choice. Lives in a memo so the FocalPicker and the slide config
  // share a single source of truth.
  const summaryHero = useMemo(() => {
    if (summaryHeroChoice === "custom") {
      return { url: null as string | null, dataUrl: summaryCustomHero };
    }
    if (summaryHeroChoice.startsWith("entry-")) {
      const idx = parseInt(summaryHeroChoice.slice("entry-".length), 10);
      return { url: items[idx]?.imageUrl ?? null, dataUrl: null };
    }
    return { url: extracted?.heroImageUrl ?? null, dataUrl: null };
  }, [summaryHeroChoice, summaryCustomHero, items, extracted]);

  const slides = useMemo(() => {
    if (!extracted) return [];
    return buildSlides(
      extracted,
      title,
      items,
      brand,
      coverPosition,
      includeSummary,
      summaryStyle,
      { hero: summaryHero, position: summaryHeroPosition },
      reverseListOrder,
    );
  }, [
    extracted,
    title,
    items,
    brand,
    coverPosition,
    includeSummary,
    summaryStyle,
    summaryHero,
    summaryHeroPosition,
    reverseListOrder,
  ]);

  function handleSummaryHeroUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setSummaryCustomHero(reader.result as string);
    reader.readAsDataURL(file);
  }

  function handleItemImageUpload(
    e: React.ChangeEvent<HTMLInputElement>,
    index: number,
  ) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () =>
      updateItem(setItems, index, {
        imageDataUrl: reader.result as string,
        // Reset focal point when the image source changes so the user starts
        // from center rather than a stale crop tuned for the previous image.
        imagePosition: DEFAULT_POSITION,
      });
    reader.readAsDataURL(file);
    // Allow re-uploading the same file again (Chrome won't fire change a
    // second time for the same filename unless we reset the input value).
    e.target.value = "";
  }

  async function handlePreview() {
    if (!slides.length) return;
    setPreviewing(true);
    setError(null);
    try {
      const results: string[] = [];
      for (let i = 0; i < slides.length; i++) {
        const r = await fetch("/api/render", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slides,
            format: "single",
            index: i,
          }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error ?? `Render failed (slide ${i + 1})`);
        }
        const blob = await r.blob();
        results.push(URL.createObjectURL(blob));
        setPreviews([...results]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleDownload() {
    if (!slides.length) return;
    setDownloading(true);
    setError(null);
    try {
      const r = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slides, format: "zip" }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? "Download failed");
      }
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "instagram-carousel.zip";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  async function handleGenerateFacebookCopy() {
    if (!extracted) return;
    if (!anthropicKey.trim()) {
      setFbError("Paste your Anthropic API key first.");
      return;
    }
    // Persist or clear the key based on the user's preference. Always run this
    // on click so toggling the checkbox takes effect even if the key didn't change.
    if (typeof window !== "undefined") {
      if (rememberKey) {
        window.localStorage.setItem(ANTHROPIC_KEY_STORAGE, anthropicKey.trim());
      } else {
        window.localStorage.removeItem(ANTHROPIC_KEY_STORAGE);
      }
    }
    setFbError(null);
    setFbLoading(true);
    try {
      const variants = await generateFacebookCopy(anthropicKey, {
        title,
        items: items.map((it) => ({ rank: it.rank, heading: it.heading })),
        url: extracted.url,
        siteName: brand.siteName,
      });
      setFbVariants(variants);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Generation failed";
      setFbError(msg);
    } finally {
      setFbLoading(false);
    }
  }

  function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setBrand((b) => ({ ...b, logoDataUrl: reader.result as string }));
    };
    reader.readAsDataURL(file);
  }

  return (
    <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Listicle → Instagram
          </h1>
          <p className="text-zinc-400 mt-1 text-sm">
            Paste a list article URL. Get a 1080×1350 carousel in the site's brand.
          </p>
        </div>
        <button
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            window.location.href = "/login";
          }}
          className="text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2"
        >
          Sign out
        </button>
      </header>

      <form onSubmit={handleExtract} className="flex gap-2 mb-6">
        <input
          type="url"
          required
          placeholder="https://www.screenrant.com/best-..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="flex-1 px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-800 focus:border-zinc-600 outline-none"
        />
        <button
          type="submit"
          disabled={loading}
          className="px-5 py-3 rounded-lg bg-white text-zinc-950 font-medium disabled:opacity-50"
        >
          {loading ? "Fetching…" : "Extract"}
        </button>
      </form>

      {error && (
        <div className="mb-6 p-4 rounded-lg bg-red-950/40 border border-red-800 text-red-200 text-sm">
          {error}
        </div>
      )}

      {extracted?.warning && (
        <div className="mb-6 p-4 rounded-lg bg-amber-950/40 border border-amber-800 text-amber-200 text-sm">
          {extracted.warning}
        </div>
      )}

      {extracted && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
          <section className="space-y-6">
            <Panel title="Cover slide">
              <textarea
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                rows={2}
                placeholder="Cover title"
                className="w-full px-3 py-2 rounded bg-zinc-900 border border-zinc-800 resize-none mb-3"
              />
              {extracted.heroImageUrl && (
                <FocalPicker
                  src={extracted.heroImageUrl}
                  position={coverPosition}
                  onChange={setCoverPosition}
                  label="Hero crop focus"
                />
              )}
              <label className="mt-4 flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeSummary}
                  onChange={(e) => setIncludeSummary(e.target.checked)}
                  className="accent-white"
                />
                Include full-list summary slide
              </label>
              <p className="text-xs text-zinc-500 mt-1 ml-6">
                A single graphic with every entry. Drops in between the entry
                slides and the outro.
              </p>
              <label className="mt-3 flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={reverseListOrder}
                  onChange={(e) => setReverseListOrder(e.target.checked)}
                  className="accent-white"
                />
                Reverse list order (#1 last → #1 first)
              </label>
              <p className="text-xs text-zinc-500 mt-1 ml-6">
                Use for countdown articles where the article reveals #1 last.
                Defaults on for TheGamer.
              </p>
              {includeSummary && (
                <div className="mt-2 ml-6 space-y-3">
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">
                      Summary layout
                    </label>
                    <select
                      value={summaryStyle}
                      onChange={(e) =>
                        setSummaryStyle(e.target.value as SummaryStyle)
                      }
                      className="px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-xs"
                    >
                      <option value="ranked-overlay">
                        Ranked overlay (hero photo + ranked cards) — TheGamer
                      </option>
                      <option value="hero-overlay">
                        Hero photo + white pill cards (GameRant)
                      </option>
                      <option value="ranked">
                        Ranked list (dark bg, simple rows)
                      </option>
                    </select>
                    <p className="text-xs text-zinc-600 mt-1">
                      Defaults based on the source site; override per article.
                    </p>
                  </div>
                  {(summaryStyle === "hero-overlay" ||
                    summaryStyle === "ranked-overlay") && (
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1">
                        Summary background image
                      </label>
                      <select
                        value={summaryHeroChoice}
                        onChange={(e) => {
                          setSummaryHeroChoice(e.target.value);
                          setSummaryHeroPosition(DEFAULT_POSITION);
                        }}
                        className="w-full px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-xs"
                      >
                        <option value="article">Article hero</option>
                        {items.map((it, i) => (
                          <option key={i} value={`entry-${i}`}>
                            #{it.rank ?? i + 1}:{" "}
                            {it.heading.length > 40
                              ? it.heading.slice(0, 40) + "…"
                              : it.heading}
                          </option>
                        ))}
                        <option value="custom">Upload custom…</option>
                      </select>
                      {summaryHeroChoice === "custom" && (
                        <div className="mt-2 space-y-2">
                          <input
                            type="file"
                            accept="image/*"
                            onChange={handleSummaryHeroUpload}
                            className="text-xs"
                          />
                          {summaryCustomHero && (
                            <button
                              onClick={() => setSummaryCustomHero(null)}
                              className="text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2"
                              type="button"
                            >
                              Clear upload
                            </button>
                          )}
                        </div>
                      )}
                      {(summaryHero.dataUrl ?? summaryHero.url) && (
                        <div className="mt-3">
                          <FocalPicker
                            src={summaryHero.dataUrl ?? summaryHero.url ?? ""}
                            position={summaryHeroPosition}
                            onChange={setSummaryHeroPosition}
                            label="Summary crop focus"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Panel>

            <Panel title="Suggested Facebook copy">
              <p className="text-xs text-zinc-500 mb-3">
                Three different angles for promoting this listicle on Facebook.
                Tuned to social media best practices: 1–2 sentences, hook in the
                first ~125 characters, no clickbait, no hashtags.
              </p>
              <div className="mb-3">
                <Field label="Your Anthropic API key">
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder="sk-ant-..."
                    value={anthropicKey}
                    onChange={(e) => setAnthropicKey(e.target.value)}
                    className="w-full px-3 py-2 rounded bg-zinc-900 border border-zinc-800 focus:border-zinc-600 outline-none font-mono text-xs"
                  />
                </Field>
                <label className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
                  <input
                    type="checkbox"
                    checked={rememberKey}
                    onChange={(e) => setRememberKey(e.target.checked)}
                    className="accent-white"
                  />
                  Remember this key in my browser
                </label>
                <p className="text-xs text-zinc-500 mt-1">
                  Generation runs in your browser; the key is sent only to
                  Anthropic. Get one at{" "}
                  <a
                    href="https://console.anthropic.com/"
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:text-zinc-300"
                  >
                    console.anthropic.com
                  </a>{" "}
                  — set a spend limit (e.g. $10/mo) before pasting.
                </p>
              </div>
              <div className="flex items-center gap-3 mb-3">
                <button
                  onClick={handleGenerateFacebookCopy}
                  disabled={fbLoading || !title || items.length === 0 || !anthropicKey.trim()}
                  className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {fbLoading
                    ? "Generating…"
                    : fbVariants.length > 0
                      ? "Regenerate"
                      : "Generate suggestions"}
                </button>
                <span className="text-xs text-zinc-500">
                  Powered by Claude Sonnet 4.6 (~$0.005 per generation).
                </span>
              </div>
              {fbError && (
                <p className="text-xs text-red-400 mb-3">{fbError}</p>
              )}
              {fbVariants.length > 0 && (
                <ul className="space-y-2">
                  {fbVariants.map((v, i) => (
                    <FacebookVariant key={i} index={i + 1} value={v} />
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title={`List items (${items.length})`}
              action={
                <button
                  onClick={() =>
                    setItems((prev) => {
                      // Next rank = one past the current max, so manual
                      // inserts default to the end of the sequence even if
                      // the list is partial / reordered.
                      const maxRank = prev.reduce(
                        (m, it) => (it.rank != null && it.rank > m ? it.rank : m),
                        0,
                      );
                      return [
                        ...prev,
                        {
                          rank: maxRank + 1,
                          heading: "",
                          body: "",
                          imageUrl: null,
                          imageDataUrl: null,
                        },
                      ];
                    })
                  }
                  className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700"
                >
                  + Add entry
                </button>
              }
            >
              <div className="space-y-3">
                {items.map((it, i) => {
                  const effectiveImage = it.imageDataUrl ?? it.imageUrl;
                  return (
                    <div
                      key={i}
                      className="p-3 rounded bg-zinc-900 border border-zinc-800 space-y-2"
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          value={it.rank ?? ""}
                          onChange={(e) =>
                            updateItem(setItems, i, {
                              rank: e.target.value ? Number(e.target.value) : null,
                            })
                          }
                          className="w-16 px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-sm"
                        />
                        <input
                          value={it.heading}
                          onChange={(e) =>
                            updateItem(setItems, i, { heading: e.target.value })
                          }
                          placeholder="Heading"
                          className="flex-1 px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-sm font-medium"
                        />
                        <div className="flex flex-col">
                          <button
                            onClick={() => moveItem(setItems, i, -1)}
                            disabled={i === 0}
                            className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed px-1 leading-none"
                            title="Move up"
                            type="button"
                          >
                            ▲
                          </button>
                          <button
                            onClick={() => moveItem(setItems, i, 1)}
                            disabled={i === items.length - 1}
                            className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed px-1 leading-none"
                            title="Move down"
                            type="button"
                          >
                            ▼
                          </button>
                        </div>
                        <button
                          onClick={() =>
                            setItems((prev) => prev.filter((_, j) => j !== i))
                          }
                          className="text-xs text-zinc-500 hover:text-red-400 px-2"
                          title="Remove entry"
                          type="button"
                        >
                          ✕
                        </button>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <label className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 cursor-pointer">
                          {effectiveImage ? "Replace image" : "Upload image"}
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) =>
                              handleItemImageUpload(e, i)
                            }
                          />
                        </label>
                        {it.imageDataUrl && (
                          <button
                            onClick={() =>
                              updateItem(setItems, i, { imageDataUrl: null })
                            }
                            className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2"
                            type="button"
                          >
                            {it.imageUrl ? "Reset to auto-detected" : "Clear"}
                          </button>
                        )}
                        {!effectiveImage && (
                          <span className="text-zinc-500">
                            No image found — upload one to fix
                          </span>
                        )}
                      </div>
                      {effectiveImage && (
                        <FocalPicker
                          src={effectiveImage}
                          position={it.imagePosition ?? DEFAULT_POSITION}
                          onChange={(p) =>
                            updateItem(setItems, i, { imagePosition: p })
                          }
                        />
                      )}
                    </div>
                  );
                })}
                {items.length === 0 && (
                  <p className="text-sm text-zinc-500">
                    No items yet. Add some manually.
                  </p>
                )}
              </div>
            </Panel>

            <div className="flex gap-3">
              <button
                onClick={handlePreview}
                disabled={previewing || !slides.length}
                className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50"
              >
                {previewing ? "Rendering…" : "Preview slides"}
              </button>
              <button
                onClick={handleDownload}
                disabled={downloading || !slides.length}
                className="px-4 py-2 rounded bg-white text-zinc-950 font-medium disabled:opacity-50"
              >
                {downloading ? "Packaging…" : `Download ZIP (${slides.length})`}
              </button>
            </div>

            {previews.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {previews.map((src, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={src}
                    alt={`Slide ${i + 1}`}
                    className="w-full rounded border border-zinc-800"
                  />
                ))}
              </div>
            )}
          </section>

          <aside className="space-y-6">
            <Panel title="Branding">
              <div className="space-y-3 text-sm">
                <Field label="Site name">
                  <input
                    value={brand.siteName}
                    onChange={(e) =>
                      setBrand({ ...brand, siteName: e.target.value })
                    }
                    className="w-full px-2 py-1 rounded bg-zinc-900 border border-zinc-800"
                  />
                </Field>
                <Field label="Accent color">
                  <ColorField
                    value={brand.accentColor}
                    onChange={(v) => setBrand({ ...brand, accentColor: v })}
                  />
                </Field>
                <Field label="Background">
                  <ColorField
                    value={brand.bgColor}
                    onChange={(v) => setBrand({ ...brand, bgColor: v })}
                  />
                </Field>
                <Field label="Text">
                  <ColorField
                    value={brand.textColor}
                    onChange={(v) => setBrand({ ...brand, textColor: v })}
                  />
                </Field>
                <Field label="Detected font">
                  <div className="text-zinc-400 text-xs">
                    {brand.fontFamily} — rendered as Inter (font licensing)
                  </div>
                </Field>
                <Field label="Logo">
                  <div className="space-y-2">
                    {(brand.logoDataUrl || brand.logoUrl) && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={brand.logoDataUrl ?? brand.logoUrl ?? ""}
                        alt="Logo"
                        className="h-8 bg-zinc-800 rounded p-1"
                      />
                    )}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleLogoUpload}
                      className="text-xs"
                    />
                    {brand.logoDataUrl && (
                      <button
                        onClick={() =>
                          setBrand({ ...brand, logoDataUrl: null })
                        }
                        className="text-xs text-zinc-500 hover:text-zinc-300"
                      >
                        Reset to auto-detected
                      </button>
                    )}
                  </div>
                </Field>
              </div>
            </Panel>
          </aside>
        </div>
      )}
    </main>
  );
}

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg bg-zinc-900/50 border border-zinc-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-zinc-500 mb-1">{label}</span>
      {children}
    </label>
  );
}

function ColorField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-2">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-12 rounded bg-zinc-900 border border-zinc-800 cursor-pointer"
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 px-2 py-1 rounded bg-zinc-900 border border-zinc-800 font-mono text-xs"
      />
    </div>
  );
}

function updateItem(
  setItems: React.Dispatch<React.SetStateAction<ListItem[]>>,
  index: number,
  patch: Partial<ListItem>,
) {
  setItems((prev) =>
    prev.map((it, i) => (i === index ? { ...it, ...patch } : it)),
  );
}

/**
 * Move an item up or down in the list. `delta` is +1 to move down, -1 to
 * move up. Ranks are *not* automatically re-numbered — the user controls
 * the rank field independently because some lists are reverse-order
 * countdowns (10 -> 1) and we don't want to second-guess that.
 */
function moveItem(
  setItems: React.Dispatch<React.SetStateAction<ListItem[]>>,
  index: number,
  delta: number,
) {
  setItems((prev) => {
    const next = index + delta;
    if (next < 0 || next >= prev.length) return prev;
    const copy = [...prev];
    const [removed] = copy.splice(index, 1);
    copy.splice(next, 0, removed);
    return copy;
  });
}

function FacebookVariant({ index, value }: { index: number; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Fallback for older browsers / non-secure contexts.
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      } finally {
        document.body.removeChild(ta);
      }
    }
  }
  return (
    <li className="p-3 rounded bg-zinc-900 border border-zinc-800">
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">
          Variant {index}
        </span>
        <button
          onClick={copy}
          className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 shrink-0"
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <p className="text-sm text-zinc-200 whitespace-pre-wrap leading-relaxed">
        {value}
      </p>
    </li>
  );
}

function buildSlides(
  extracted: ExtractResult,
  title: string,
  items: ListItem[],
  brand: BrandConfig,
  coverPosition: ImagePosition,
  includeSummary: boolean,
  summaryStyle: SummaryStyle,
  summary: {
    hero: { url: string | null; dataUrl: string | null };
    position: ImagePosition;
  },
  reverseListOrder: boolean,
) {
  // Flip the array and renumber so the displayed rank always matches the
  // visual position (top = #1). Items stay in editable order in state; the
  // reversal only happens at slide-build time so the user can toggle the
  // checkbox and see the previews flip without touching state.
  const orderedItems = reverseListOrder
    ? items.slice().reverse().map((it, i) => ({ ...it, rank: i + 1 }))
    : items;
  const common = {
    accentColor: brand.accentColor,
    textColor: brand.textColor,
    bgColor: brand.bgColor,
    fontFamily: brand.fontFamily,
    siteName: brand.siteName,
    logoUrl: brand.logoUrl,
    logoDataUrl: brand.logoDataUrl,
  };
  const slides: unknown[] = [
    {
      ...common,
      kind: "cover" as const,
      title,
      subtitle: extracted.subtitle,
      totalCount: items.length,
      heroImageUrl: extracted.heroImageUrl,
      imagePosition: coverPosition,
    },
    ...orderedItems.map((it) => ({
      ...common,
      kind: "item" as const,
      rank: it.rank,
      heading: it.heading,
      // Pass both: the API route prefers itemImageDataUrl when present and
      // falls back to fetching itemImageUrl when not. Lets a user-uploaded
      // image override the auto-detected one without losing the fallback.
      itemImageUrl: it.imageUrl,
      itemImageDataUrl: it.imageDataUrl ?? null,
      imagePosition: it.imagePosition ?? DEFAULT_POSITION,
    })),
  ];
  // Summary belongs between the entry slides and the outro: viewers see the
  // full ranking once after scrolling each pick, then the CTA closes the deck.
  if (includeSummary) {
    slides.push({
      ...common,
      kind: "summary" as const,
      title,
      summaryStyle,
      handle: brand.siteName ? `@${brand.siteName.replace(/\s+/g, "").toUpperCase()}` : null,
      ctaText: "LINK IN BIO ↗",
      // hero-overlay layout fills the slide with this image (user-selectable
      // from article hero / any entry image / custom upload). The ranked
      // layout ignores both fields.
      heroImageUrl: summary.hero.url,
      heroImageDataUrl: summary.hero.dataUrl,
      imagePosition: summary.position,
      summaryEntries: orderedItems.map((it) => ({
        rank: it.rank,
        heading: it.heading,
        imageUrl: it.imageUrl,
        imageDataUrl: it.imageDataUrl ?? null,
      })),
    });
  }
  slides.push({
    ...common,
    kind: "outro" as const,
    ctaText: "Read the full article",
    sourceUrl: extracted.url,
  });
  return slides;
}

function FocalPicker({
  src,
  position,
  onChange,
  label,
}: {
  src: string;
  position: ImagePosition;
  onChange: (p: ImagePosition) => void;
  label?: string;
}) {
  function setFromEvent(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    onChange({ x: Math.round(x), y: Math.round(y) });
  }
  return (
    <div className="flex items-start gap-3">
      <div
        className="relative cursor-crosshair bg-zinc-950 rounded border border-zinc-800 overflow-hidden select-none"
        style={{ width: 80, aspectRatio: "1080 / 1350" }}
        onClick={setFromEvent}
        onMouseDown={(e) => {
          setFromEvent(e);
          const move = (ev: MouseEvent) => {
            const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
            const x = Math.max(0, Math.min(100, ((ev.clientX - rect.left) / rect.width) * 100));
            const y = Math.max(0, Math.min(100, ((ev.clientY - rect.top) / rect.height) * 100));
            onChange({ x: Math.round(x), y: Math.round(y) });
          };
          const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
          };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        }}
        title="Click or drag to set focal point"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt=""
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: `${position.x}% ${position.y}%`,
            pointerEvents: "none",
          }}
        />
        <div
          className="absolute w-3 h-3 rounded-full bg-white ring-2 ring-zinc-950 pointer-events-none"
          style={{
            left: `${position.x}%`,
            top: `${position.y}%`,
            transform: "translate(-50%, -50%)",
          }}
        />
      </div>
      <div className="text-xs text-zinc-400 space-y-1 pt-1">
        <div>{label ?? "Crop focus"}</div>
        <div className="font-mono text-zinc-500">
          {Math.round(position.x)} · {Math.round(position.y)}
        </div>
        <button
          onClick={() => onChange(DEFAULT_POSITION)}
          className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2"
          type="button"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
