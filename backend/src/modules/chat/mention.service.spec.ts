// MentionService 单元测试（Task 2.9）：@提及解析——
// 正常解析（@kb:/@file: uuid 分别收集到 kbIds/knowledgeIds）、UUID 大小写
// 归一化、前缀大小写敏感（@KB: 不识别）、无效提及移除、混合去重、cleanedText
// 移除标记。设计决策断言：小写前缀精确匹配（前端生成器固定小写）；无效提及
// 宽容移除（不报 400，避免 LLM 看到垃圾标记）；严格 v4 校验（质量审查整改：
// @kb:123/@file:not-a-uuid/@kb:xxx你好/非 v4 uuid 均不进范围且文本被清理），
// 见 mention.service.ts 文件头注释。
import { describe, expect, it } from 'vitest';
import { MentionService } from './mention.service.js';

describe('MentionService（@提及解析）', () => {
  const service = new MentionService();
  const kbId = '11111111-1111-4111-8111-111111111111';
  const fileId = '22222222-2222-4222-8222-222222222222';

  it('正常解析：@kb 与 @file 分别收集到 kbIds/knowledgeIds，提及标记从文本移除', () => {
    const result = service.parse(
      `请检索 @kb:${kbId} 中关于智能客服的资料，参考 @file:${fileId}`,
    );
    expect(result.kbIds).toEqual([kbId]);
    expect(result.knowledgeIds).toEqual([fileId]);
    // cleanedText：提及标记移除 + 残留空白折叠
    expect(result.cleanedText).toBe('请检索 中关于智能客服的资料，参考');
  });

  it('UUID 大小写不敏感：大写 uuid 归一化为小写', () => {
    const result = service.parse(`@kb:${kbId.toUpperCase()}`);
    expect(result.kbIds).toEqual([kbId]);
  });

  it('前缀大小写敏感：@KB: 不识别（小写前缀精确匹配），保留原文不误删', () => {
    const result = service.parse(`@KB:${kbId}`);
    expect(result.kbIds).toEqual([]);
    expect(result.knowledgeIds).toEqual([]);
    expect(result.cleanedText).toContain(`@KB:${kbId}`);
  });

  it('无效提及（@kb: 后跟非 uuid）→ 从文本移除、不进范围（宽容语义）', () => {
    const result = service.parse('请检索 @kb:not-a-uuid 资料');
    expect(result.kbIds).toEqual([]);
    expect(result.knowledgeIds).toEqual([]);
    expect(result.cleanedText).toBe('请检索 资料');
  });

  it('质量审查整改：@kb:123 / @file:not-a-uuid / @kb:xxx你好 均不进范围且文本被清理', () => {
    const result = service.parse(
      '请检索 @kb:123 与 @file:not-a-uuid 及 @kb:xxx你好 资料',
    );
    expect(result.kbIds).toEqual([]);
    expect(result.knowledgeIds).toEqual([]);
    // 三类非 uuid 文本全部走无效提及移除（宽容语义，不报 400）
    expect(result.cleanedText).toBe('请检索 与 及 资料');
    expect(result.cleanedText).not.toContain('@kb:');
    expect(result.cleanedText).not.toContain('@file:');
  });

  it('质量审查整改：非 v4 UUID（版本位不是 4）→ 不进范围、文本移除（严格 v4 校验）', () => {
    // 36 字符全 hex 但版本位是 0（非 4）：旧正则会误收进 kbIds → 后续 SQL
    // 22P02/检索失效；严格 v4 正则不捕获，整段走无效提及移除
    const result = service.parse('@kb:aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa');
    expect(result.kbIds).toEqual([]);
    expect(result.cleanedText).toBe('');
  });

  it('混合提及去重：重复提及只保留一个 id', () => {
    const result = service.parse(`@kb:${kbId} @kb:${kbId} @file:${fileId}`);
    expect(result.kbIds).toEqual([kbId]);
    expect(result.knowledgeIds).toEqual([fileId]);
  });

  it('无提及：范围为空，文本原样返回（trim 环绕空白）', () => {
    const result = service.parse('  普通问题  ');
    expect(result.kbIds).toEqual([]);
    expect(result.knowledgeIds).toEqual([]);
    expect(result.cleanedText).toBe('普通问题');
  });

  it('提及嵌在词中/无空格分隔：标记仍被解析并移除（不粘连前后文本）', () => {
    const result = service.parse(`请检索@kb:${kbId}资料`);
    expect(result.kbIds).toEqual([kbId]);
    expect(result.cleanedText).toBe('请检索资料');
  });
});
