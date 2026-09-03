import { MigrationInterface, QueryRunner } from "typeorm";

/** 分块图片列（多模态：image caption 块独立入检索 + 引用带图） */
export class AddChunkImage1788353597067 implements MigrationInterface {
    name = 'AddChunkImage1788353597067'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "chunks" ADD "type" character varying NOT NULL DEFAULT 'text'`);
        await queryRunner.query(`ALTER TABLE "chunks" ADD "assetKey" character varying`);
        await queryRunner.query(`ALTER TABLE "chunks" ADD "imageInfo" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "chunks" DROP COLUMN "imageInfo"`);
        await queryRunner.query(`ALTER TABLE "chunks" DROP COLUMN "assetKey"`);
        await queryRunner.query(`ALTER TABLE "chunks" DROP COLUMN "type"`);
    }
}
