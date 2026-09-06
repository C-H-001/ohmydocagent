import { MigrationInterface, QueryRunner } from "typeorm";

/** 用量明细表（按日趋势图数据源——每次对话一条，90 天滚动保留） */
export class AddUsageEvents1788631990664 implements MigrationInterface {
    name = 'AddUsageEvents1788631990664'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "usage_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "modelId" uuid NOT NULL, "modelName" character varying NOT NULL DEFAULT '', "type" character varying NOT NULL DEFAULT 'chat', "inputTokens" integer NOT NULL DEFAULT '0', "outputTokens" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_usage_events" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_usage_events_user_date" ON "usage_events" ("userId", "createdAt")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "usage_events"`);
    }
}
