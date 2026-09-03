// 聊天历史路由（Task 2.11，全部需登录——全局 JwtAuthGuard 默认拦截）：
// GET /chat/history 历史搜索（keyword 必填 + 分页）、
// GET /chat/history/stats 按知识库统计（days 窗口，缺省 30）、
// DELETE /chat/history 清空全部会话（200 { deleted }）。
// 数据隔离：搜索/统计/清空全部限当前用户（服务层 join/filter userId）——无
// 按会话 id 的入参，天然无归属 403 分支（他人数据不可见由服务层保证，见
// chat-history.service.ts 注释与 e2e「他人数据不可见」用例）。
// 路由顺序：GET /chat/history（根）与 GET /chat/history/stats 无冲突——
// Express 根路径精确匹配（end:true），stats 不会被根路径吞掉（与
// DELETE /chat/sessions/batch 必须前置的坑不同，见 session.controller.ts 注释）。
// 清空确认语义（决策，见 chat-history.service.ts clearAll 注释）：API 不加
// confirm 参数——二次确认是前端 UI 责任（浏览器对话框），服务端幂等可重放
// （重复调用对无会话用户返回 { deleted: 0 }）。
import { Controller, Delete, Get, HttpCode, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { User } from '../users/user.entity.js';
import { ChatHistoryService } from './chat-history.service.js';
import { HistorySearchDto } from './dto/history-search.dto.js';
import { HistoryStatsDto } from './dto/history-stats.dto.js';

@Controller('chat/history')
export class ChatHistoryController {
  constructor(private readonly historyService: ChatHistoryService) {}

  /** 历史搜索：keyword 必填（DTO 400：空/纯空白/缺失/超长）→ 分页返回
   * 本人消息命中（messageId/sessionId/sessionTitle/role/摘要/createdAt） */
  @Get()
  search(@Query() query: HistorySearchDto, @CurrentUser() user: User) {
    return this.historyService.search(
      user.id,
      query.keyword,
      query.page,
      query.pageSize,
    );
  }

  /** 按知识库统计：days 窗口（缺省 30，1..365）→ 引用聚合数组
   * （kbId/kbName?/messageCount/citationCount，口径见服务层注释） */
  @Get('stats')
  stats(@Query() query: HistoryStatsDto, @CurrentUser() user: User) {
    return this.historyService.stats(user.id, query.days);
  }

  /** 清空全部会话：200 { deleted }（前端二次确认，见文件头决策注释） */
  @Delete()
  @HttpCode(200)
  clearAll(@CurrentUser() user: User): Promise<{ deleted: number }> {
    return this.historyService.clearAll(user.id);
  }
}
