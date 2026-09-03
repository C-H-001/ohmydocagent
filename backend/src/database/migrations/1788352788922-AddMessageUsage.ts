import { MigrationInterface, QueryRunner } from "typeorm";

/** 消息 token 用量列（assistant 消息：{ inputTokens, outputTokens, cacheHitTokens }） */
export class AddMessageUsage1788352788922 implements MigrationInterface {
    name = 'AddMessageUsage1788352788922'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "messages" ADD "usage" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "usage"`);
    }
}
