import type { HeuristicScamResult, RiskLevel, ScamSignal, SuspiciousLink } from "../ai.types";

/**
 * Local, deterministic scam/spam signal detection. Runs entirely on the
 * ConnectX server — nothing is sent to an AI provider — so it can safely
 * run over a whole visible conversation. It is a heuristic: it flags
 * patterns common in scams, it does not (and cannot) verify that a
 * message is a scam. Results are presented as warnings, never used to
 * block messages.
 */

const URL_PATTERN = /\b((?:https?:\/\/|www\.)[^\s<>"')\]]+)/gi;

const SHORTENERS = new Set([
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
  "rb.gy",
  "tiny.cc",
]);

const RISKY_TLDS = new Set(["zip", "mov", "xyz", "top", "click", "country", "gq", "tk", "ml", "cf", "ga", "work", "support", "loan"]);

/** Well-known brands that phishing links commonly imitate. A host mentioning one without being that brand's domain is suspicious. */
const IMITATED_BRANDS: Array<{ word: string; domains: string[] }> = [
  { word: "paypal", domains: ["paypal.com"] },
  { word: "apple", domains: ["apple.com", "icloud.com"] },
  { word: "microsoft", domains: ["microsoft.com", "live.com", "office.com"] },
  { word: "google", domains: ["google.com", "youtube.com", "goo.gl"] },
  { word: "amazon", domains: ["amazon.com", "amazon.in", "amazon.co.uk"] },
  { word: "netflix", domains: ["netflix.com"] },
  { word: "whatsapp", domains: ["whatsapp.com"] },
  { word: "facebook", domains: ["facebook.com", "fb.com"] },
  { word: "instagram", domains: ["instagram.com"] },
  { word: "bank", domains: [] },
];

interface PatternRule {
  type: ScamSignal["type"];
  description: string;
  weight: number;
  patterns: RegExp[];
}

const RULES: PatternRule[] = [
  {
    type: "credential_request",
    description: "Asks for a password, one-time code, PIN or login details. Legitimate services never ask for these in a chat.",
    weight: 3,
    patterns: [
      /\b(send|share|give|tell|confirm|verify|enter|provide)\b[^.!?\n]{0,40}\b(password|passcode|otp|one[- ]time (?:code|password)|verification code|security code|2fa code|pin|cvv|login details|credentials)\b/i,
      /\b(otp|verification code|security code|one[- ]time code)\b[^.!?\n]{0,30}\b(you (?:just )?received|sent to your (?:phone|number))\b/i,
      /\b(verify|confirm|update)\b[^.!?\n]{0,25}\b(your )?(account|identity|bank details|card details)\b/i,
    ],
  },
  {
    type: "payment_request",
    description: "Asks for money in a hard-to-reverse form (gift cards, crypto, wire transfer or an upfront fee).",
    weight: 2,
    patterns: [
      /\bgift ?cards?\b/i,
      /\b(bitcoin|btc|crypto(?:currency)?|usdt|ethereum|eth wallet)\b/i,
      /\b(wire transfer|western union|moneygram)\b/i,
      /\b(processing|release|clearance|registration|delivery|customs) fee\b/i,
      /\b(send|transfer|pay)\b[^.!?\n]{0,30}\b(money|payment|\$\s?\d|₹\s?\d|€\s?\d|£\s?\d|\d+\s?(usd|inr|eur|gbp|rs))\b/i,
    ],
  },
  {
    type: "urgency",
    description: "Uses pressure or a threat to rush you (urgent deadline, account suspension, legal action).",
    weight: 1,
    patterns: [
      /\b(urgent(?:ly)?|immediately|right now|asap|act now|final (?:notice|warning)|last chance)\b/i,
      /\bwithin (?:the next )?\d+\s?(minutes?|hours?|hrs?)\b/i,
      /\b(account|card|number|sim)\b[^.!?\n]{0,25}\b(suspended|blocked|locked|deactivated|closed|terminated)\b/i,
      /\b(legal action|arrest|police|penalty)\b/i,
    ],
  },
  {
    type: "impersonation",
    description: "Claims to be from a bank, support team, official body or a known person on a new number.",
    weight: 2,
    patterns: [
      /\b(this is|i am|i'm|we are)\b[^.!?\n]{0,25}\b(from|with)\b[^.!?\n]{0,25}\b(bank|support|customer care|help ?desk|it department|security team|tax|government|police)\b/i,
      /\b(new number|changed my number|lost my phone)\b/i,
      /\b(customer (?:care|support|service))\b[^.!?\n]{0,30}\b(call|contact|whatsapp)\b/i,
    ],
  },
  {
    type: "too_good_to_be_true",
    description: "Promises a prize, refund or unusually high return you didn't expect.",
    weight: 1,
    patterns: [
      /\b(you(?:'ve| have)? won|congratulations[^.!?\n]{0,30}(winner|won|selected)|claim your (?:prize|reward|refund))\b/i,
      /\b(guaranteed (?:returns?|profit)|double your (?:money|investment)|risk[- ]free investment)\b/i,
      /\b(lottery|jackpot)\b/i,
    ],
  },
];

function analyzeLink(raw: string): SuspiciousLink | null {
  const reasons: string[] = [];
  let url: URL;
  try {
    url = new URL(raw.startsWith("www.") ? `http://${raw}` : raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const labels = host.split(".");
  const tld = labels[labels.length - 1] ?? "";

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) reasons.push("Points to a raw IP address instead of a named website");
  if (host.includes("xn--")) reasons.push("Uses look-alike (internationalized) characters in the address");
  if (SHORTENERS.has(host)) reasons.push("Uses a link shortener that hides the real destination");
  if (RISKY_TLDS.has(tld)) reasons.push(`Uses a ".${tld}" domain, which is common in scam links`);
  if (url.username || url.password) reasons.push("Contains embedded login details (\"user@\" in the address)");
  if (labels.length >= 5) reasons.push("Has an unusually long chain of subdomains");
  for (const brand of IMITATED_BRANDS) {
    if (!host.includes(brand.word)) continue;
    const isOfficial = brand.domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (!isOfficial) {
      reasons.push(
        brand.word === "bank"
          ? "Mentions \"bank\" in a web address that may not belong to your bank"
          : `Mentions "${brand.word}" but isn't an official ${brand.word} address`
      );
    }
  }
  if (url.protocol === "http:" && reasons.length > 0) reasons.push("Isn't a secure (https) link");
  return reasons.length > 0 ? { url: raw, reasons } : null;
}

export function analyzeScamSignals(text: string): HeuristicScamResult {
  const signals: ScamSignal[] = [];
  let score = 0;

  const rawLinks = [...new Set((text.match(URL_PATTERN) ?? []).map((link) => link.replace(/[.,!?;:]+$/, "")))].slice(0, 20);
  const links = rawLinks.map(analyzeLink).filter((link): link is SuspiciousLink => link !== null);
  if (links.length > 0) {
    signals.push({ type: "suspicious_link", description: "Contains a link with warning signs." });
    score += 2;
  }

  const found = new Set<ScamSignal["type"]>();
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      found.add(rule.type);
      signals.push({ type: rule.type, description: rule.description });
      score += rule.weight;
    }
  }

  const hasLink = rawLinks.length > 0;
  let riskLevel: RiskLevel = "likely_safe";
  if (
    score >= 5 ||
    (found.has("credential_request") && (hasLink || found.has("urgency") || found.has("impersonation"))) ||
    (found.has("payment_request") && (found.has("urgency") || found.has("impersonation")))
  ) {
    riskLevel = "high_risk";
  } else if (score >= 2) {
    riskLevel = "suspicious";
  }

  return { riskLevel, signals, links };
}

const RISK_ORDER: Record<RiskLevel, number> = { likely_safe: 0, suspicious: 1, high_risk: 2 };

export function higherRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}
