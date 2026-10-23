export const auditActions = {
  query: '查询/查看',
  export: '导出',
  operation: '操作请求',
  request_failed: '操作失败',
  create_record: '新增记录',
  update_record: '修改记录',
  delete_record: '删除记录',
  login: '登录',
  login_failed: '登录失败',
  import_purchases: '导入采购',
  import_orders: '历史订单导入',
  edit_item: '编辑订单',
  assign_purchase_channels: '分配采购渠道',
  batch_update_order_status: '批量更新运营状态',
  batch_update_purchase_status: '批量更新采购状态',
  walmart_sync_order: 'Walmart同步',
  walmart_sync_config: '调整同步配置',
  create_store: '新增店铺',
  edit_store: '编辑店铺',
  create_user: '新增账号',
  edit_user: '编辑账号',
  save_risk_address: '维护风险地址',
  import_risk_addresses: '批量导入风险地址',
  delete_risk_address: '删除风险地址',
  management_batch_delete: '批量删除',
};
const resources = {
  orders: '订单管理',
  purchases: '采购信息',
  assignments: '采购渠道分配',
  users: '账号管理',
  stores: '店铺管理',
  templates: '导入模板',
  imports: '采购导入',
  dictionaries: '下拉选项维护',
  'risk-addresses': '风险地址',
  uploads: '文件上传',
  'audit-logs': '操作日志',
  auth: '账号登录与安全',
};
export function auditResource(value) {
  const parts = String(value || '')
    .replace(/^\/api\//, '')
    .replace(/^management\//, '')
    .split('/');
  return resources[parts[0]] || value || '—';
}
