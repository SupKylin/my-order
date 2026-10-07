export function excelFileFromClipboard(event) {
  const clipboard = event.clipboardData;
  if (!clipboard) return null;
  const files = [
    ...clipboard.files,
    ...[...clipboard.items].filter((item) => item.kind === 'file').map((item) => item.getAsFile()),
  ].filter(Boolean);
  return files.find((file) => /\.xlsx$/i.test(file.name)) || null;
}
