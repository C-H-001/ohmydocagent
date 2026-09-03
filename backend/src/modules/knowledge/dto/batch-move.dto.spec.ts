// BatchMoveDto 校验测试（Task 1.8 质量审查整改补测）：钉住 @ValidateIf +
// @IsDefined 的 null 短路行为——folderId=null（移回根）必须通过校验，缺省
// folderId（undefined）必须被 @IsDefined 拒绝（400 语义），非法 UUID 必须被
// @IsUUID 拒绝。校验逻辑与 ValidationPipe（whitelist+transform）同源，直接对
// DTO 断言（与 common/pagination.spec.ts 同一模式）。
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BatchMoveDto } from './batch-move.dto.js';

describe('BatchMoveDto', () => {
  const validIds = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'];
  const validFolder = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  /** 模拟 ValidationPipe 的 transform：请求体 → DTO 实例 → 校验错误列表 */
  async function validateDto(
    body: Record<string, unknown>,
  ): Promise<{ dto: BatchMoveDto; errorCount: number; messages: string[] }> {
    const dto = plainToInstance(BatchMoveDto, body);
    const errors = await validate(dto);
    return {
      dto,
      errorCount: errors.length,
      messages: errors.flatMap((e) => Object.values(e.constraints ?? {})),
    };
  }

  it('folderId=null（移回根）→ 通过（@ValidateIf 短路 @IsUUID，null 合法）', async () => {
    const { dto, errorCount } = await validateDto({
      ids: validIds,
      folderId: null,
    });
    expect(errorCount).toBe(0);
    expect(dto.folderId).toBeNull();
  });

  it('缺省 folderId（undefined）→ 拒绝（@IsDefined 必填，对应 HTTP 400）', async () => {
    const { errorCount, messages } = await validateDto({ ids: validIds });
    expect(errorCount).toBeGreaterThan(0);
    expect(messages.join('; ')).toContain('folderId 必填');
  });

  it('folderId 非 UUID → 拒绝（@IsUUID，400 语义；与 null 短路互斥）', async () => {
    const { errorCount } = await validateDto({
      ids: validIds,
      folderId: 'not-a-uuid',
    });
    expect(errorCount).toBeGreaterThan(0);
  });

  it('folderId 合法 UUID → 通过', async () => {
    const { dto, errorCount } = await validateDto({
      ids: validIds,
      folderId: validFolder,
    });
    expect(errorCount).toBe(0);
    expect(dto.folderId).toBe(validFolder);
  });
});
