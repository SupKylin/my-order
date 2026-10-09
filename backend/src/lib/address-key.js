import { createHash } from 'node:crypto';

export const addressFields = ['address1', 'address2', 'city', 'state', 'postalCode'];
export const normalizeAddressPart = (value) =>
  String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

/** 仅忽略大小写和多余空白；房号、邮编和标点保留，避免误标不同收件地址。 */
export function addressKey(address) {
  const parts = addressFields.map((key) => normalizeAddressPart(address[key]));
  if (!parts[0] || !parts[2] || !parts[3] || !parts[4]) return null;
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
