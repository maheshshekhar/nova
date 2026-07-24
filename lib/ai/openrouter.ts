// OpenRouter attribution headers (optional metadata OpenRouter shows in its
// dashboard). Config-driven via env so nothing is hardcoded: the app title
// defaults to the product name, and HTTP-Referer is only sent when a site URL is
// explicitly configured (never a hardcoded localhost).
export function openRouterAttribution(): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Title": process.env.OPENROUTER_APP_TITLE || "Nova",
  }
  const referer = process.env.OPENROUTER_SITE_URL
  if (referer) headers["HTTP-Referer"] = referer
  return headers
}
