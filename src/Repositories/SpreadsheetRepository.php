<?php

declare(strict_types=1);

namespace Blanket\Repositories;

use Blanket\Db;

final class SpreadsheetRepository
{
    /** @return array{id:int,owner_id:int,title:string,created_at:string,updated_at:string,deleted_at:?string}|null */
    public function find(int $id): ?array
    {
        $stmt = Db::connection()->prepare(
            'SELECT id, owner_id, title, created_at, updated_at, deleted_at
             FROM spreadsheets WHERE id = :id AND deleted_at IS NULL'
        );
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch();
        return $row === false ? null : $this->cast($row);
    }

    /** Spreadsheets owned by the user, or where the user has an explicit spreadsheet_access row. */
    public function listForUser(int $userId): array
    {
        $stmt = Db::connection()->prepare(
            'SELECT DISTINCT s.id, s.owner_id, s.title, s.created_at, s.updated_at, s.deleted_at
             FROM spreadsheets s
             LEFT JOIN spreadsheet_access a ON a.spreadsheet_id = s.id AND a.user_id = :user_id
             WHERE s.deleted_at IS NULL AND (s.owner_id = :user_id OR a.id IS NOT NULL)
             ORDER BY s.updated_at DESC'
        );
        $stmt->execute(['user_id' => $userId]);
        return array_map($this->cast(...), $stmt->fetchAll());
    }

    public function create(int $ownerId, string $title): int
    {
        $stmt = Db::connection()->prepare(
            'INSERT INTO spreadsheets (owner_id, title) VALUES (:owner_id, :title)'
        );
        $stmt->execute(['owner_id' => $ownerId, 'title' => $title]);
        return (int) Db::connection()->lastInsertId();
    }

    public function rename(int $id, string $title): void
    {
        $stmt = Db::connection()->prepare('UPDATE spreadsheets SET title = :title WHERE id = :id');
        $stmt->execute(['title' => $title, 'id' => $id]);
    }

    public function softDelete(int $id): void
    {
        $stmt = Db::connection()->prepare(
            'UPDATE spreadsheets SET deleted_at = CURRENT_TIMESTAMP WHERE id = :id'
        );
        $stmt->execute(['id' => $id]);
    }

    /** Real DELETE, cascades to tabs -> spreadsheet_history and to spreadsheet_access. Admin only, enforced by the caller. */
    public function hardDelete(int $id): void
    {
        $stmt = Db::connection()->prepare('DELETE FROM spreadsheets WHERE id = :id');
        $stmt->execute(['id' => $id]);
    }

    private function cast(array $row): array
    {
        $row['id'] = (int) $row['id'];
        $row['owner_id'] = (int) $row['owner_id'];
        return $row;
    }
}
