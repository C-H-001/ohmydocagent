import { MigrationInterface, QueryRunner } from "typeorm";

/** 文档图片资产登记列（多模态：grpc-parser asset 落盘 → knowledge.images） */
export class AddKnowledgeImages1788347542916 implements MigrationInterface {
    name = 'AddKnowledgeImages1788347542916'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "knowledge" ADD "images" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "knowledge" DROP COLUMN "images"`);
    }
}
