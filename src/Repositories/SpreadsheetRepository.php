<?php

declare(strict_types=1);

namespace Blanket\Repositories;

use Blanket\Db;
use Blanket\Support\Uuid;

final class SpreadsheetRepository
{
    /** @return array{id:int,guid:string,owner_id:int,title:string,created_at:string,updated_at:string,deleted_at:?string}|null */
    public function find(int $id): ?array
    {
        $stmt = Db::connection()->prepare(
            'SELECT id, guid, owner_id, title, created_at, updated_at, deleted_at
             FROM spreadsheets WHERE id = :id AND deleted_at IS NULL'
        );
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch();
        return $row === false ? null : $this->cast($row);
    }

    /** @return array{id:int,guid:string,owner_id:int,title:string,created_at:string,updated_at:string,deleted_at:?string}|null */
    public function findByGuid(string $guid): ?array
    {
        $stmt = Db::connection()->prepare(
            'SELECT id, guid, owner_id, title, created_at, updated_at, deleted_at
             FROM spreadsheets WHERE guid = :guid AND deleted_at IS NULL'
        );
        $stmt->execute(['guid' => $guid]);
        $row = $stmt->fetch();
        return $row === false ? null : $this->cast($row);
    }

    /**
     * Spreadsheets owned by the user, or where the user has an explicit
     * spreadsheet_access row.
     *
     * Uses two distinct placeholders for the same value on purpose: with
     * PDO::ATTR_EMULATE_PREPARES => false (native prepares, see Db.php),
     * MySQL's native protocol does not support reusing one named
     * placeholder for multiple positions in a query -- binding the same
     * name twice throws SQLSTATE[HY093] at execute() time, since one bound
     * value can't fill two slots. This is a systemic risk, not a one-off:
     * any query with a repeated :name is broken under this driver config.
     */
    /**
     * $titleContains: case-insensitive substring match (Fernando: "query my
     * spreadsheets, filter with 'TEMPLATE' in the name"). LOWER() on both
     * sides rather than relying on the column's collation being
     * case-insensitive -- correct either way, regardless of how this table
     * is collated. `%`/`_`/`\` in the search string are escaped so a title
     * like "50% off" can't be misread as a LIKE wildcard.
     */
    public function listForUser(int $userId, ?string $titleContains = null): array
    {
        $sql = 'SELECT DISTINCT s.id, s.guid, s.owner_id, s.title, s.created_at, s.updated_at, s.deleted_at
             FROM spreadsheets s
             LEFT JOIN spreadsheet_access a ON a.spreadsheet_id = s.id AND a.user_id = :user_id1
             WHERE s.deleted_at IS NULL AND (s.owner_id = :user_id2 OR a.id IS NOT NULL)';
        $params = ['user_id1' => $userId, 'user_id2' => $userId];

        if ($titleContains !== null && $titleContains !== '') {
            $escaped = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $titleContains);
            $sql .= ' AND LOWER(s.title) LIKE LOWER(:title_contains) ESCAPE \'\\\\\'';
            $params['title_contains'] = '%' . $escaped . '%';
        }

        $sql .= ' ORDER BY s.updated_at DESC';

        $stmt = Db::connection()->prepare($sql);
        $stmt->execute($params);
        return array_map($this->cast(...), $stmt->fetchAll());
    }

    public function create(int $ownerId, string $title): int
    {
        $stmt = Db::connection()->prepare(
            'INSERT INTO spreadsheets (guid, owner_id, title) VALUES (:guid, :owner_id, :title)'
        );
        $stmt->execute(['guid' => Uuid::v4(), 'owner_id' => $ownerId, 'title' => $title]);
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
