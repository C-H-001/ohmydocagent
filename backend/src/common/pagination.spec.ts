// backend/src/common/pagination.spec.ts
// PaginationDto 边界测试：page/pageSize 的非法输入必须被校验拒绝（对应 HTTP 400），
// 缺省值回落到 page=1/pageSize=10。校验逻辑与 ValidationPipe（whitelist+transform）
// 同源——class-transformer @Type 转数字 + class-validator 装饰器规则，此处直接对 DTO 断言。
// reflect-metadata：装饰器元数据运行时依赖（class-transformer 的 @Type 等），单测环境需显式引入
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaginationDto } from './pagination.js';

describe('PaginationDto', () => {
  /** 模拟 ValidationPipe 的 transform：字符串查询参数 → DTO 实例 → 校验错误列表 */
  async function validateQuery(
    query: Record<string, unknown>,
  ): Promise<{ dto: PaginationDto; errorCount: number; messages: string[] }> {
    const dto = plainToInstance(PaginationDto, query);
    const errors = await validate(dto);
    return {
      dto,
      errorCount: errors.length,
      messages: errors.flatMap((e) => Object.values(e.constraints ?? {})),
    };
  }

  it('page=abc 校验失败（非整数 → 400）', async () => {
    const { errorCount, messages } = await validateQuery({
      page: 'abc',
      pageSize: '10',
    });
    expect(errorCount).toBeGreaterThan(0);
    expect(messages.join('; ')).toContain('page 必须是整数');
  });

  it('pageSize=0 校验失败（小于最小 1 → 400）', async () => {
    const { errorCount, messages } = await validateQuery({
      page: '1',
      pageSize: '0',
    });
    expect(errorCount).toBeGreaterThan(0);
    expect(messages.join('; ')).toContain('pageSize 最小为 1');
  });

  it('pageSize=1000 校验失败（超过上限 100 → 400）', async () => {
    const { errorCount, messages } = await validateQuery({
      page: '1',
      pageSize: '1000',
    });
    expect(errorCount).toBeGreaterThan(0);
    expect(messages.join('; ')).toContain('pageSize 最大为 100');
  });

  it('缺省参数回落默认值 page=1 / pageSize=10，且无校验错误', async () => {
    const { dto, errorCount } = await validateQuery({});
    expect(errorCount).toBe(0);
    expect(dto.page).toBe(1);
    expect(dto.pageSize).toBe(10);
  });

  it('合法参数经 transform 转为数字并原样通过', async () => {
    const { dto, errorCount } = await validateQuery({
      page: '2',
      pageSize: '20',
    });
    expect(errorCount).toBe(0);
    expect(dto.page).toBe(2);
    expect(dto.pageSize).toBe(20);
  });
});
