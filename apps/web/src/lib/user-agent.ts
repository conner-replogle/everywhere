// Just enough User-Agent parsing to label a session ("Chrome on Linux").

function browser(ua: string): string | null {
  // Order matters: most browsers also claim to be Chrome and/or Safari.
  if (/Edg(e|A|iOS)?\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/Vivaldi\//.test(ua)) return "Vivaldi";
  if (/SamsungBrowser\//.test(ua)) return "Samsung Internet";
  if (/Firefox\/|FxiOS\//.test(ua)) return "Firefox";
  if (/Chrome\/|CriOS\/|Chromium\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return "Safari";
  if (/curl\//i.test(ua)) return "curl";
  if (/Go-http-client/.test(ua)) return "Go client";
  return null;
}

function os(ua: string): string | null {
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux|X11/.test(ua)) return "Linux";
  return null;
}

export function describeUserAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const b = browser(ua);
  const o = os(ua);
  if (b && o) return `${b} on ${o}`;
  return b ?? o ?? (ua.length > 40 ? `${ua.slice(0, 40)}…` : ua);
}
