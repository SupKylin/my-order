export const riskAddressColumns = [
  { key: 'address1', label: '地址一', required: true },
  { key: 'address2', label: '地址二' },
  { key: 'city', label: '城市', required: true },
  { key: 'state', label: '州', required: true },
  { key: 'postalCode', label: '邮编', required: true },
  { key: 'note', label: '风险备注' },
];

export const RISK_ADDRESS_IMPORT_MAX_ROWS = 1000;
export const RISK_ADDRESS_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
