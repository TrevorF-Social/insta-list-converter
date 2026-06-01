import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

// Generates three Facebook-tuned post copy variants for a listicle via
// Anthropic Claude. Runs in the browser — each user supplies their own API
// key so the cost lands on their account, not the server's.
//
// Browser API-key handling carries XSS risk (the key sits in the page's JS
// memory and optionally in localStorage); we accept it because this app is
// behind a shared-password gate used by a known team. Don't ship this pattern
// to a public-facing app.

const SYSTEM_PROMPT = `You are an editorial social-media writer for an entertainment / gaming publication. Your job is to write Facebook post copy that promotes LIST ARTICLES ("listicles") to a feed-scrolling audience.

Rules:
- Each post is 1–2 short sentences, 40–80 words total.
- Open with a hook in the first ~125 characters — Facebook truncates after that with a "See more". The hook must make someone stop scrolling.
- Do NOT just restate the title. Reframe the list for social: a question, a tease about a surprising pick, a "who got left off?" framing, a stakes/opinion hook, or curiosity about which entry made #1.
- Conversational tone. Avoid title-style noun stacks ("X stuns Y with Z move").
- No clickbait phrasing. Specifically avoid: "You won't believe", "This is crazy", excessive emphasis, ALL CAPS, multiple exclamation marks.
- No emoji unless the content genuinely calls for one (rare).
- No hashtags. Facebook generally suppresses reach on posts with hashtags.
- A soft call-to-engagement is fine when natural ("Which one's your favorite?", "Who got snubbed?"), but skip if forced.
- You may reference one or two specific entries by name to ground the hook, but never spoil the full ranking and never reveal what's #1 directly.

Generate exactly three variants. Each variant MUST take a meaningfully different approach:
- Variant 1: a curiosity hook (question or implied question) that hints at the list without spoiling
- Variant 2: a specific-detail hook that names one entry on the list and uses it as the wedge ("From X to the underdog at #4, here's...")
- Variant 3: an opinion/stakes hook — controversy, ranking debate, or a snub angle ("Fans are going to fight about this one.")

Return only the three post bodies. No commentary, no labels.`;

const VariantsSchema = z.object({
  variants: z
    .array(z.string().min(20).max(800))
    .length(3)
    .describe("Three Facebook post copy variants, each a different angle."),
});

export type ListEntry = { rank: number | null; heading: string };

export type SocialCopyInput = {
  title: string;
  items: ListEntry[];
  url: string;
  siteName: string | null;
};

export async function generateFacebookCopy(
  apiKey: string,
  input: SocialCopyInput,
): Promise<string[]> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new Error("Anthropic API key required");
  }

  const client = new Anthropic({
    apiKey: trimmed,
    // The SDK refuses to run in the browser by default to protect operators
    // from leaking server-side keys. In our case the user is supplying their
    // own key, so the protection doesn't apply.
    dangerouslyAllowBrowser: true,
  });

  // Compact the list to "1. Foo / 2. Bar / ..." rather than dumping JSON —
  // shorter prompt, same signal. Cap at the first 15 entries so very long
  // ranked listicles don't blow up the context unnecessarily.
  const listLines = input.items
    .slice(0, 15)
    .map((it) => `${it.rank ?? "•"}. ${it.heading}`)
    .join("\n");

  // Per-article variation lives in the user turn; the system prompt is held
  // stable and cache-controlled so repeated generations within a 5-minute
  // window cost ~10% of the first.
  const userMessage = [
    `Site: ${input.siteName ?? "(unknown)"}`,
    `Title: ${input.title}`,
    `URL: ${input.url}`,
    "",
    "The list (in order):",
    listLines,
    "",
    "Write three Facebook post variants per the rules in your system prompt.",
  ].join("\n");

  const response = await client.messages.parse({
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
    output_config: { format: zodOutputFormat(VariantsSchema) },
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error("Claude returned no parsed output");
  }
  return parsed.variants;
}
