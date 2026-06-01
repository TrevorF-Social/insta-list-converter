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

export type ListItem = {
  rank: number | null;
  heading: string;
  body: string;
  imageUrl: string | null;
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
