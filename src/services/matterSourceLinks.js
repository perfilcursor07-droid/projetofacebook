function cleanSourceUrl(raw) {
  const value = String(raw || '')
    .trim()
    .replace(/[\])},.;:!?]+$/g, '');

  if (!/^https?:\/\//i.test(value)) return null;

  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function sourceHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return 'Abrir fonte';
  }
}

function labelBeforeUrl(line, urlIndex) {
  return String(line || '')
    .slice(0, urlIndex)
    .replace(/^\s*(?:fonte(?:s)?\s*:\s*)?/i, '')
    .replace(/^\s*[?*\-??]+\s*/, '')
    .replace(/\s*[\-??:]+\s*$/, '')
    .trim();
}

function extractMatterSourceLinks(matter = {}) {
  const sources = [];
  const seen = new Set();

  const add = (rawUrl, rawLabel = '') => {
    const url = cleanSourceUrl(rawUrl);
    if (!url) return;

    const key = url.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) return;

    seen.add(key);
    sources.push({
      url,
      label: String(rawLabel || '').trim() || sourceHost(url)
    });
  };

  for (const field of [matter.fonte_credito, matter.contexto_apuracao]) {
    for (const line of String(field || '').split(/\r?\n/)) {
      const matches = [...line.matchAll(/https?:\/\/[^\s<>"']+/gi)];
      for (const match of matches) {
        add(match[0], labelBeforeUrl(line, match.index || 0));
      }
    }
  }

  add(matter.fonte_url, '');
  return sources;
}

module.exports = { extractMatterSourceLinks, cleanSourceUrl };
