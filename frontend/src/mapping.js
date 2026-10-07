/** 优先匹配原列；列位置改变时只接受唯一同名表头，避免映射到错误列。 */
export function alignMappings(mappings, columns) {
  const found = [],
    missing = [];
  for (const mapping of mappings) {
    const exact = columns.find(
      (c) => c.column === mapping.column && c.header.trim() === mapping.header.trim(),
    );
    const candidates = columns.filter((c) => c.header.trim() === mapping.header.trim());
    const column = exact || (candidates.length === 1 ? candidates[0] : null);
    if (column) found.push({ ...mapping, column: column.column, header: column.header });
    else if (mapping.field?.trim()) missing.push(mapping);
  }
  // 复用模板时也展示新增源列，但不替用户决定其映射目标。
  const matchedColumns = new Set(found.map((mapping) => mapping.column));
  for (const column of columns) {
    if (!matchedColumns.has(column.column))
      found.push({ column: column.column, header: column.header, field: '' });
  }
  found.sort((a, b) => a.column - b.column);
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
    column: column.column,
    header: column.header,
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
  const columns = new Map();
  const targets = new Map();
  for (const [index, mapping] of mappings.entries()) {
    if (!mapping.field?.trim()) continue;
    const column = Number(mapping.column);
    const label = `第 ${index + 1} 条映射`;
    if (!Number.isInteger(column) || column < 1 || column > 500)
      issues.push({ index, message: `${label}：请选择或填写 1–500 的 Excel 列号` });
    else if (columns.has(column))
      issues.push({
        index,
        message: `${label}：Excel 第 ${column} 列已被第 ${columns.get(column) + 1} 条使用`,
      });
    else columns.set(column, index);
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
