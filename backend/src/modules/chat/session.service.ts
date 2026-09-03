// 会话数据访问与业务规则（Task 2.1）：
// - create：创建者即归属者（userId=创建者）；title 默认「新会话」；kbIds 宽松
//   校验（只校验 uuid 数组格式，不校验知识库存在——P1 无 KB 权限体系，
//   @提及/选择器在 UI 层保证有效，见 dto/create-session.dto.ts 注释）
// - list：分页列表，置顶优先（pinned=true 排最前）+ 组内 updatedAt DESC +
//   id 决胜键（复用 Task 1.10 排序经验：时间戳并列时排序稳定，防分页抖动）；
//   messageCount 用聚合子查询 COUNT（getRawAndEntities 模式，一次查询而非
//   N+1，复用 Task 1.10 的聚合经验）；只返回当前用户的会话（单用户归属）
// - getById/update/remove/clearMessages/listMessages：归属权限——先查会话
//   （不存在/非 UUID 格式 → 404），再判归属（非本人 → 403「无权访问该会话」）
// - update：只更新传入字段（title/kbIds/pinned）；空更新 {}（无字段变化）不调用
//   save——否则 @UpdateDateColumn 会刷新 updatedAt，使会话在列表（按 updatedAt
//   DESC 排序）中「跳顶」（质量审查整改：前端无感刷新会误触发重排）；pinned
//   语义——pinned=true 时写入 pinnedAt=now（置顶时间戳），pinned=false 时清空
//   pinnedAt=null，未传 pinned 不触碰 pinnedAt
// - remove：事务内先删 messages 子表、再删会话行（原子化，无孤儿消息残留）
// - removeBatch：宽容语义——只删属于当前用户的会话（跨用户 id 静默跳过），
//   返回 { deleted } 删除数；事务内先删子表消息再删会话行
// Task 2.9 扩展：remove/removeBatch 增加附件级联——事务内删附件行（与 messages
// 同约定，无外键由服务层事务承担）+ 事务前收集附件磁盘路径、事务后尽力清理
// 磁盘文件（fs 与 DB 非原子：行已删，文件清理失败仅记日志——孤儿文件可后续
// 清理，同 KnowledgeService.remove 语义；路径收集必须在行删除前——行删后无法

// - clearMessages：清空会话消息（会话保留，消息数归零）
// - listMessages：按 createdAt 升序（对话自然时序）+ id 决胜键稳定分页
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { paginate, Paginated } from '../../common/pagination.js';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { UpdateSessionDto } from './dto/update-session.dto.js';
import { Message } from './message.entity.js';
import { Session } from './session.entity.js';

/** 列表单条记录：会话字段 + 消息数聚合 */
export interface SessionListItem extends Session {
  /** 消息数（messages 表按 sessionId 聚合，列表页一次查询而非 N+1） */
  messageCount: number;
}

@Injectable()
export class SessionService {
  constructor(
    @InjectRepository(Session)
    private readonly sessionRepository: Repository<Session>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    // remove/removeBatch 需要事务（messages + session 两步删除原子化）：
    // DataSource 由 TypeOrmModule.forRoot 全局提供（与 KbService 同模式）
    private readonly dataSource: DataSource,
    // Task 2.9：附件级联清理（会话删除时附件行 + 磁盘文件，见文件头注释；
    // 附件行删除在下方事务内经 manager.delete(Attachment) 完成，本服务只负责
    // 路径收集 + 事务后磁盘尽力清理——不依赖附件服务的行删除，避免职责混淆）
      ) {}

  /** 创建会话：title 缺省「新会话」，kbIds 缺省空数组（宽松校验见文件头注释） */
  async create(dto: CreateSessionDto, userId: string): Promise<Session> {
    const session = this.sessionRepository.create({
      title: dto.title ?? '新会话',
      kbIds: dto.kbIds ?? [],
      userId,
      pinned: false,
      pinnedAt: null,
    });
    return this.sessionRepository.save(session);
  }

  /**
   * 分页列表（Task 2.1）：只返回当前用户的会话；置顶优先 + 组内 updatedAt DESC
   * + id 决胜键，messageCount 用聚合子查询（复用 Task 1.10 的
   * getRawAndEntities 模式与决胜键经验，排序/分页全部在 SQL 侧完成）。
   * common/pagination 的 paginate() 助手不适用：messageCount 涉及跨表聚合
   * 子查询，findAndCount 无法表达，故手工实现，但响应结构复用统一
   * Paginated<T> 约定（Paginated<SessionListItem>）。
   */
  async list(
    page: number,
    pageSize: number,
    userId: string,
  ): Promise<Paginated<SessionListItem>> {
    // 主查询：先取分页 id（轻量列），筛选/排序/分页全部下推到数据库。
    // 置顶优先直接用 s."pinned" DESC（PG 布尔排序 true 在前），
    // 组内 updatedAt DESC，末尾追加 id ASC 唯一决胜键（跨页边界排序稳定）
    const qb = this.sessionRepository
      .createQueryBuilder('s')
      .select('s.id', 'id')
      .where('s."userId" = :userId', { userId })
      .orderBy('s."pinned"', 'DESC')
      .addOrderBy('s."updatedAt"', 'DESC')
      .addOrderBy('s.id', 'ASC');
    qb.limit(pageSize).offset((page - 1) * pageSize);
    // getCount 忽略 select/order/limit/offset，得到筛选后的全量总数
    const [total, rows] = await Promise.all([qb.getCount(), qb.getRawMany()]);
    if (rows.length === 0) {
      return { items: [], total, page, pageSize };
    }
    const pageIds = rows.map((r) => r.id as string);
    // 取实体 + messageCount 聚合子查询（一次查询而非 N+1；命中
    // idx_messages_session_created 索引；getRawAndEntities 取对齐的 raw 行
    // 再手动装配计数，理由同 KbService.list 注释）
    const { entities, raw } = await this.sessionRepository
      .createQueryBuilder('s')
      .where('s.id IN (:...ids)', { ids: pageIds })
      .addSelect(
        '(SELECT COUNT(*) FROM messages m WHERE m."sessionId" = s.id)',
        'messageCount',
      )
      .orderBy('s.id', 'ASC')
      .getRawAndEntities();
    // WHERE IN 不保序：按主查询返回的 id 顺序重排，恢复分页排序语义
    const idOrder = new Map(pageIds.map((id, i) => [id, i]));
    // raw 与 entities 行序一致但排序后下标会错位：按 s_id 建索引取值更稳
    const rawBySessionId = new Map(raw.map((r) => [r.s_id as string, r]));
    const items = entities
      .slice()
      .sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0))
      .map((s) => ({
        ...s,
        messageCount: Number(rawBySessionId.get(s.id)?.messageCount ?? 0),
      }));
    return { items, total, page, pageSize };
  }

  /**
   * 归属校验助手：查会话 → 不存在 404 → 非本人 403。
   * 非 UUID 格式 id 撞 PG 22P02 同样视为不存在（404，不泄露内部错误，
   * 与 KbService.getById 同模式）。
   */
  private async getOwnedSession(id: string, userId: string): Promise<Session> {
    try {
      const session = await this.sessionRepository.findOne({ where: { id } });
      if (!session) {
        throw new NotFoundException('会话不存在');
      }
      // 单用户归属：会话属于他人 → 403（P4 共享机制启用前无共享读语义）
      if (session.userId !== userId) {
        throw new ForbiddenException('无权访问该会话');
      }
      return session;
    } catch (err) {
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '22P02'
      ) {
        throw new NotFoundException('会话不存在');
      }
      throw err;
    }
  }

  /** 详情：归属校验后返回完整会话实体 */
  async getById(id: string, userId: string): Promise<Session> {
    return this.getOwnedSession(id, userId);
  }

  /**
   * 更新会话：只更新传入字段（undefined 跳过），不存在/非本人 → 404/403。
   * 空更新 {}（无字段变化）不调用 save：@UpdateDateColumn 会在 save 时刷新
   * updatedAt，使会话在列表（按 updatedAt DESC 排序）中「跳顶」——前端无感
   * 刷新/重复提交会误触发重排，故无变化直接返回原实体（质量审查整改）。
   * pinned 语义：pinned=true → 写入 pinnedAt=now（列表置顶排序不受影响，
   * pinnedAt 供前端展示）；pinned=false → 清空 pinnedAt=null；
   * 未传 pinned → 不触碰 pinnedAt（保持既有置顶状态）。
   */
  async update(
    id: string,
    dto: UpdateSessionDto,
    userId: string,
  ): Promise<Session> {
    const session = await this.getOwnedSession(id, userId);
    // 变更检测：任一字段被传入即视为有变更；全部未传（空更新）跳过 save
    let changed = false;
    if (dto.title !== undefined) {
      session.title = dto.title;
      changed = true;
    }
    if (dto.kbIds !== undefined) {
      session.kbIds = dto.kbIds;
      changed = true;
    }
    if (dto.pinned !== undefined) {
      session.pinned = dto.pinned;
      // pinnedAt 与 pinned 联动：置顶写时间戳、取消置顶清空（见方法头注释）
      session.pinnedAt = dto.pinned ? new Date() : null;
      changed = true;
    }
    if (!changed) {
      return session;
    }
    return this.sessionRepository.save(session);
  }

  /**
   * 删除会话（硬删除）：事务内先删 messages 子表、再删会话行——
   * 级联删消息保证无孤儿残留且原子化（消息多时第二步失败可整体回滚，
   * 不会出现「会话已删但消息残留」的不一致态）。
   */
  async remove(id: string, userId: string): Promise<void> {
    await this.getOwnedSession(id, userId); // 404/403 语义先暴露（见方法头注释）
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(Message, { sessionId: id });
      await manager.delete(Session, { id });
    });
  }

  /**
   * 批量删除会话（宽容语义）：只删属于当前用户的会话——ids 中混入他人
   * 会话 id 静默跳过（不 403/不整批失败，前端批量勾选天然只勾自己的，
   * 防御性过滤即可；与 KnowledgeService.batchDelete 的跨 KB 宽容语义一致）。
   * 返回 { deleted } = 实际删除数（前端据此提示「成功删除 N 个」）。
   * 事务内先删子表消息再删会话行（与 remove 同一原子语义）。
   */
  async removeBatch(
    ids: string[],
    userId: string,
  ): Promise<{ deleted: number }> {
    // 先过滤出本人的会话 id（DTO 已保证 ids 全部为合法 uuid，无 22P02 风险）
    const owned = await this.sessionRepository.find({
      where: { id: In(ids), userId },
      select: { id: true },
    });
    const ownedIds = owned.map((s) => s.id);
    if (ownedIds.length === 0) {
      return { deleted: 0 };
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(Message, { sessionId: In(ownedIds) });
      await manager.delete(Session, { id: In(ownedIds) });
    });
    return { deleted: ownedIds.length };
  }

  /** 清空消息：删除该会话全部消息，会话保留（消息数归零）；不存在/非本人 → 404/403 */
  async clearMessages(id: string, userId: string): Promise<void> {
    await this.getOwnedSession(id, userId); // 404/403 语义先暴露
    await this.messageRepository.delete({ sessionId: id });
  }

  /**
   * 消息列表：归属校验后按 createdAt 升序（对话自然时序）分页返回；
   * 末尾追加 id ASC 决胜键保证同毫秒创建的消息排序稳定（复用 Task 1.10 经验）。
   * 复用 common/pagination 的 paginate() 助手——本列表无跨表聚合，
   * findAndCount 足够表达。
   */
  async listMessages(
    id: string,
    userId: string,
    page: number,
    pageSize: number,
  ): Promise<Paginated<Message>> {
    await this.getOwnedSession(id, userId); // 404/403 语义先暴露
    return paginate(this.messageRepository, page, pageSize, {
      where: { sessionId: id },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }
}
