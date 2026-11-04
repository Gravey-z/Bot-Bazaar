// The wallet executes inline code in an opaque-origin srcdoc sandbox. Keep
// script restrictions for a separately verified nonce-capable hosting setup.
export const securityHeaders = Object.freeze({
  "Content-Security-Policy":
    "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
});
