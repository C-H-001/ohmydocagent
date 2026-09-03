// ApiKeyGuard 单元测试（Task 4.5）：三种路径——
// 1. JWT 路径：req.user 已存在 → 放行（不重复校验）；
// 2. API Key 路径：X-API-Key 缺失/无效 → 401；有效 → 注入 admin 身份；
// 3. 组合语义说明：guard 只做认证判定，角色裁决交给 RolesGuard（挂 @Roles
//    的端点按注入身份 role=admin 判定，本用例用身份断言覆盖）。
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ApiKeyGuard } from './platform-api-key.guard.js';

/** 构造最小 ExecutionContext（headers 可注入） */
function makeContext(headers: Record<string, string | undefined> = {}): {
  context: ExecutionContext;
  request: Record<string, unknown>;
} {
  const request: Record<string, unknown> = { headers };
  return {
    request,
    context: {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext,
  };
}

describe('ApiKeyGuard', () => {
  const makeGuard = (validate: ReturnType<typeof vi.fn>) =>
    new ApiKeyGuard({ validate } as never);

  it('JWT 路径：req.user 已存在 → 直接放行（不查 X-API-Key）', async () => {
    const validate = vi.fn();
    const guard = makeGuard(validate);
    const { context, request } = makeContext();
    request.user = { id: 'u1', role: 'admin' };
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(validate).not.toHaveBeenCalled();
  });

  it('API Key 路径：缺少 X-API-Key 请求头 → 401', async () => {
    const guard = makeGuard(vi.fn());
    const { context } = makeContext({});
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('API Key 路径：key 无效/已暂停 → 401（不泄露 key 是否存在）', async () => {
    const validate = vi.fn().mockResolvedValue(null);
    const guard = makeGuard(validate);
    const { context } = makeContext({ 'x-api-key': 'dm_invalid' });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('API Key 路径：key 有效 → 注入 admin 身份并放行', async () => {
    const validate = vi.fn().mockResolvedValue({
      id: 'key-1',
      name: '运维脚本',
      type: 'api-key',
      role: 'admin',
    });
    const guard = makeGuard(validate);
    const { context, request } = makeContext({ 'x-api-key': 'dm_valid' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      id: 'key-1',
      name: '运维脚本',
      type: 'api-key',
      role: 'admin',
    });
    expect(validate).toHaveBeenCalledWith('dm_valid');
  });
});
