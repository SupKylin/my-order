export function imageValues(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map((item) => String(item));
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed.filter(Boolean).map((item) => String(item));
      } catch {}
    }
    return text ? [text] : [];
  }
  return value == null || value === '' ? [] : [String(value)];
}
