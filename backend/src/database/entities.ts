// backend/src/database/entities.ts
// 实体统一出口：新增实体在此集中导出，database.module 与后续任务一律从该索引导入
import { ProbeEntity } from './probe.entity.js';
import { Invitation } from '../modules/invitations/invitation.entity.js';
import { KnowledgeBase } from '../modules/kb/kb.entity.js';
import { UserKbPin } from '../modules/kb/user-kb-pin.entity.js';
import { UserKbFavorite } from '../modules/kb/user-kb-favorite.entity.js';
import { UserKbRecent } from '../modules/kb/user-kb-recent.entity.js';
import { Chunk } from '../modules/chunk/chunk.entity.js';
import { ChunkRevision } from '../modules/chunk/chunk-revision.entity.js';
import { Knowledge } from '../modules/knowledge/knowledge.entity.js';
import { KnowledgeFolder } from '../modules/knowledge/folder.entity.js';
import { KnowledgeTag } from '../modules/knowledge/knowledge-tag.entity.js';
import { Tag } from '../modules/knowledge/tag.entity.js';
import { User } from '../modules/users/user.entity.js';
import { ModelUsage } from '../modules/usage/model-usage.entity.js';
import { Session } from '../modules/chat/session.entity.js';
import { Message } from '../modules/chat/message.entity.js';
import { Model } from '../modules/model/model.entity.js';
import { KnowledgeBaseShare } from '../modules/kb-share/kb-share.entity.js';
import { AuditLog } from '../modules/admin/audit/audit-log.entity.js';
import { PlatformApiKey } from '../modules/admin/api-key/platform-api-key.entity.js';
import { SystemSetting } from '../modules/admin/settings/system-setting.entity.js';

/** 全部 TypeORM 实体列表（供 forRootAsync entities 与 forFeature 使用） */
export const entities = [
  ProbeEntity,
  User,
  ModelUsage,
  Invitation,
  KnowledgeBase,
  UserKbPin,
  UserKbFavorite,
  UserKbRecent,
  Knowledge,
  Chunk,
  ChunkRevision,
  KnowledgeFolder,
  Tag,
  KnowledgeTag,
  Session,
  Message,
  Model,
  KnowledgeBaseShare,
  // Task 4.3~4.6 系统管理：审计日志/平台 API Key/全局设置
  AuditLog,
  PlatformApiKey,
  SystemSetting,
];

export {
  ProbeEntity,
  User,
  ModelUsage,
  Invitation,
  KnowledgeBase,
  UserKbPin,
  UserKbFavorite,
  UserKbRecent,
  Knowledge,
  Chunk,
  ChunkRevision,
  KnowledgeFolder,
  Tag,
  KnowledgeTag,
  Session,
  Message,
  Model,
  KnowledgeBaseShare,
  AuditLog,
  PlatformApiKey,
  SystemSetting,
};
