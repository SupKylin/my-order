/** 仅接受唯一同名表头，旧模板列号不参与匹配。 */
export function alignMappings(mappings, columns) {
  const found = [],
    missing = [];
  for (const mapping of mappings) {
    const candidates = columns.filter((c) => c.header.trim() === mapping.header.trim());
    const column = candidates.length === 1 ? candidates[0] : null;
    if (column) found.push({ header: column.header.trim(), field: mapping.field });
    else if (mapping.field?.trim()) missing.push(mapping);
  }
  // 复用模板时也展示新增源列，但不替用户决定其映射目标。
  const matchedHeaders = new Set(found.map((mapping) => mapping.header));
  for (const column of columns) {
    if (!matchedHeaders.has(column.header.trim()))
      found.push({ header: column.header.trim(), field: '' });
  }
  found.sort(
    (a, b) =>
      columns.findIndex((c) => c.header.trim() === a.header) -
      columns.findIndex((c) => c.header.trim() === b.header),
  );
  return { mappings: found, missing };
}

/** 同一系统字段被多个列建议时，不自动选边，由用户明确指定来源。 */
export function ambiguousSuggestions(columns = []) {
  const byField = new Map();
  for (const column of columns) {
    if (!column.suggestedField) continue;
    const sources = byField.get(column.suggestedField) || [];
    sources.push(column);
    byField.set(column.suggestedField, sources);
  }
  return [...byField.entries()]
    .filter(([, sources]) => sources.length > 1)
    .map(([field, sources]) => ({ field, sources }));
}

/** 展示所有源列；未知或有歧义的表头保留空目标，等待用户选择。 */
export function suggestedMappings(columns) {
  const ambiguous = new Set(ambiguousSuggestions(columns).map((item) => item.field));
  return columns.map((column) => ({
    header: column.header.trim(),
    field: !ambiguous.has(column.suggestedField) ? column.suggestedField || '' : '',
  }));
}

/** 仅提取实际参与导入的关系；保存模板时应保留未选择目标的源列。 */
export function selectedMappings(mappings = []) {
  return mappings.filter((mapping) => typeof mapping?.field === 'string' && mapping.field.trim());
}

/** 只校验已选择系统字段的关系；订单号是唯一必填映射，WalmartSku 可选。 */
export function mappingIssues(mappings = [], fields = []) {
  const issues = [];
  const fieldMap = new Map(fields.map((field) => [field.key, field]));
  const headers = new Map();
  const targets = new Map();
  for (const [index, mapping] of mappings.entries()) {
    if (!mapping.field?.trim()) continue;
    const header = String(mapping.header || '').trim();
    const label = `第 ${index + 1} 条映射`;
    if (!header) issues.push({ index, message: `${label}：请选择或填写 Excel 表头名称` });
    else if (headers.has(header))
      issues.push({
        index,
        message: `${label}：Excel 表头“${header}”已被第 ${headers.get(header) + 1} 条使用`,
      });
    else headers.set(header, index);
    if (!fieldMap.has(mapping.field))
      issues.push({ index, message: `${label}：请选择有效的系统字段` });
    else if (targets.has(mapping.field))
      issues.push({
        index,
        message: `${label}：系统字段“${fieldMap.get(mapping.field).label}”已被第 ${targets.get(mapping.field) + 1} 条使用，请修改或删除重复关系`,
      });
    else targets.set(mapping.field, index);
  }
  const missing = fields.filter((field) => field.required && !targets.has(field.key));
  if (missing.length)
    issues.push({
      index: null,
      message: `必须映射：${missing.map((field) => field.label).join('、')}`,
    });
  return issues;
}
