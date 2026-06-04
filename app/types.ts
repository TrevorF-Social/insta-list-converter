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

export type ImagePosition = { x: number; y: number };

export type SummaryEntry = {
  rank: number | null;
  heading: string;
  imageUrl: string | null;
};

export type SummaryStyle = "ranked" | "hero-overlay";

export type ListItem = {
  rank: number | null;
  heading: string;
  body: string;
  imageUrl: string | null;
  // User-uploaded override / supplied image (data URL). Takes precedence over
  // imageUrl when present — used for entries the auto-extractor missed or for
  // replacing a wrong/low-quality auto-detected image.
  imageDataUrl?: string | null;
  imagePosition?: ImagePosition | null;
};

export type ExtractResult = {
  url: string;
  title: string;
  subtitle: string | null;
  heroImageUrl: string | null;
  items: ListItem[];
  branding: Branding;
  fetchedVia?: "fetch" | "playwright";
  warning?: string;
};

export type BrandConfig = {
  siteName: string;
  accentColor: string;
  bgColor: string;
  textColor: string;
  fontFamily: string;
  logoDataUrl: string | null;
  logoUrl: string | null;
};
