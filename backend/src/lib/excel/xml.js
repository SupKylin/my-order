import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
});
const list = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const valuesOf = (x) => (x && typeof x === 'object' && '#text' in x ? x['#text'] : x);
function walk(node, key, out = []) {
  if (!node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    if (k === key) out.push(...list(v));
    if (typeof v === 'object') for (const n of list(v)) walk(n, key, out);
  }
  return out;
}
const xml = async (zip, name) =>
  zip.file(name) ? parser.parse(await zip.file(name).async('string')) : null;
const targetPath = (base, target) =>
  path.posix.normalize(
    target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(base), target),
  );
async function relationships(zip, base) {
  const relPath = path.posix.join(
    path.posix.dirname(base),
    '_rels',
    path.posix.basename(base) + '.rels',
  );
  const doc = await xml(zip, relPath);
  return Object.fromEntries(
    list(doc?.Relationships?.Relationship)
      .filter((r) => r['@TargetMode'] !== 'External')
      .map((r) => [r['@Id'], targetPath(base, r['@Target'])]),
  );
}

export { list, valuesOf, walk, xml, relationships };
