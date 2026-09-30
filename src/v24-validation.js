const OFFICIAL_DOMAINS = ['fibernet.uz', 't.me'];

export function parsePublicHttps(raw) {
  if (typeof raw !== 'string' || raw.length > 1000 || /[\u0000-\u0020\u007f]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.hash || url.hostname.endsWith('.')) return null;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') ||
        host.endsWith('.local') || host.endsWith('.internal') ||
        host.startsWith('xn--') || host.split('.').some(part => part.startsWith('xn--')) ||
        /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
        host.startsWith('[') || !host.includes('.')) return null;
    return url;
  } catch { return null; }
}

export function validOfficialLink(raw) {
  const u = parsePublicHttps(raw);
  if (!u) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'fibernet.uz' || host.endsWith('.fibernet.uz')) return true;
  if (host === 't.me') return /^\/fibernet_[a-z0-9_]+\/?$/i.test(u.pathname);
  return false;
}

export function validMediaInput(value, isTelegramFileId = false) {
  if (isTelegramFileId) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{10,512}$/.test(value);
  }
  return !!parsePublicHttps(value);
}

export const __test = { OFFICIAL_DOMAINS };
