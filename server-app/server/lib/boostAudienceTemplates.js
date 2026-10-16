'use strict';

// 私有试用包只保留平台全地域枚举；客户画像和地域实验模板未分发。
const FULL_REGION = {
  AreaReverse: false, LocationType: 1, District: 'select', RegionVer: '2.3.2',
  City: ['11','12','13','14','15','21','22','23','31','32','33','34','35','36','37','41','42','43','44','45','46','50','51','52','53','54','61','62','63','64','65','1819729','1821274','7280291'],
  CityDivide: 0, Age: [2, 3, 4, 5, 6],
};
const TEMPLATES = { full_region: FULL_REGION };
function getTemplate(name) {
  if (name == null) return null;
  const value = TEMPLATES[String(name)];
  return value ? JSON.parse(JSON.stringify(value)) : null;
}
module.exports = { TEMPLATES, getTemplate, TEMPLATE_NAMES: Object.keys(TEMPLATES) };
