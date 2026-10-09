/** 只接受 Walmart 官方图片域名，避免把任意外部地址作为商品图片。 */
export function walmartImage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === 'walmartimages.com' || url.hostname.endsWith('.walmartimages.com'))
      ? url.href
      : null;
  } catch {
    return null;
  }
}
