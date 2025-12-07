// 通用字段校验工具，限制长度与类型，减少异常输入导致的资源消耗

export interface StringRule {
  name: string;
  value: unknown;
  min?: number;
  max?: number;
  optional?: boolean;
  pattern?: RegExp;
}

export function checkString(rule: StringRule): string | null {
  const { name, value, min = 0, max = 1024, optional = false, pattern } = rule;
  if ((value === undefined || value === null || value === '') && optional) return null;
  if (typeof value !== 'string') return `${name} 必须为字符串`;
  const len = value.length;
  if (len < min) return `${name} 长度需至少 ${min} 个字符`;
  if (len > max) return `${name} 长度不能超过 ${max} 个字符`;
  if (pattern && !pattern.test(value)) return `${name} 格式不合法`;
  return null;
}

export interface NumberRule {
  name: string;
  value: unknown;
  min?: number;
  max?: number;
  optional?: boolean;
}

export function checkNumberRange(rule: NumberRule): string | null {
  const { name, value, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, optional = false } = rule;
  if ((value === undefined || value === null || value === '') && optional) return null;
  if (typeof value !== 'number' || Number.isNaN(value)) return `${name} 必须为数字`;
  if (value < min) return `${name} 不能小于 ${min}`;
  if (value > max) return `${name} 不能大于 ${max}`;
  return null;
}

export interface ArrayRule {
  name: string;
  value: unknown;
  min?: number;
  max?: number;
  optional?: boolean;
}

export function checkArray(rule: ArrayRule): string | null {
  const { name, value, min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = rule;
  if ((value === undefined || value === null) && optional) return null;
  if (!Array.isArray(value)) return `${name} 必须为数组`;
  if (value.length < min) return `${name} 数量需至少 ${min}`;
  if (value.length > max) return `${name} 数量不能超过 ${max}`;
  return null;
}
