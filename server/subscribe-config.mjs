// 模板 ID 被覆盖时要求同时提供字段映射，避免把另一模板的字段名发给微信。
export function resolveSubscriptionTemplate({
  defaultTemplateId,
  defaultData,
  templateIdOverride = '',
  templateDataOverride = '',
}) {
  const overrideId = typeof templateIdOverride === 'string' ? templateIdOverride.trim() : '';
  const templateId = overrideId || defaultTemplateId;
  let data = defaultData;

  if (templateDataOverride) {
    try {
      data = JSON.parse(templateDataOverride);
      if (!isTemplateData(data)) throw new Error('invalid template data');
    } catch {
      return { templateId: '', data: defaultData, error: 'invalid-template-data' };
    }
  } else if (templateId !== defaultTemplateId) {
    return { templateId: '', data: defaultData, error: 'template-data-required' };
  }

  return { templateId, data, error: '' };
}

function isTemplateData(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length &&
    Object.values(value).every((item) => typeof item === 'string' || typeof item?.value === 'string'));
}
