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
     * $titleContains: case-insensitive substring match (Fernando: "query my
     * spreadsheets, filter with 'TEMPLATE' in the name"). LOWER() on both
     * sides rather than relying on the column's collation being
     * case-insensitive -- correct either way, regardless of how this table
     * is collated. `%`/`_`/`\` in the search string are escaped so a title
     * like "50% off" can't be misread as a LIKE wildcard.
     */
    private function escapeTitleContains(string $titleContains): string
    {
        return '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $titleContains) . '%';
    }

    /**
     * Spreadsheets this user owns. A direct index seek on idx_spreadsheets_
     * owner (db/schemas.md) -- no join needed, since the owner already IS
     * the highest access level, there's no separate access-level/owner-name
     * to compute or select for these rows.
     *
     * Split from the old listForUser() (see BUGS_FOUND.md [023]): that
     * single LEFT JOIN + OR query defeated index use for both halves of the
     * OR. This half and listSharedWithUser() below are each a plain,
     * independently-indexed seek instead.
     */
    public function listOwnedByUser(int $userId, ?string $titleContains = null): array
    {
        $sql = 'SELECT id, guid, owner_id, title, created_at, updated_at, deleted_at
             FROM spreadsheets
             WHERE owner_id = :user_id AND deleted_at IS NULL';
        $params = ['user_id' => $userId];

        if ($titleContains !== null && $titleContains !== '') {
            $sql .= ' AND LOWER(title) LIKE LOWER(:title_contains) ESCAPE \'\\\\\'';
            $params['title_contains'] = $this->escapeTitleContains($titleContains);
        }

        $sql .= ' ORDER BY updated_at DESC';

        $stmt = Db::connection()->prepare($sql);
        $stmt->execute($params);
        return array_map($this->cast(...), $stmt->fetchAll());
    }

    /**
     * Spreadsheets shared with this user via an explicit spreadsheet_access
     * row (not owned by them). Driven by an index seek on idx_access_user
     * (spreadsheet_access.user_id, db/schemas.md), then a PK join to
     * spreadsheets and users for the handful of matching rows -- no OR, no
     * LEFT JOIN, no DISTINCT needed since (spreadsheet_id, user_id) is
     * unique.
     *
     * @return list<array{id:int,guid:string,title:string,created_at:string,updated_at:string,owner_id:int,owner_name:string,access_level:string}>
     */
    public function listSharedWithUser(int $userId, ?string $titleContains = null): array
    {
        $sql = 'SELECT s.id, s.guid, s.title, s.created_at, s.updated_at, s.owner_id, u.display_name AS owner_name, a.access_level
             FROM spreadsheets s
             JOIN spreadsheet_access a ON a.spreadsheet_id = s.id
             JOIN users u ON u.id = s.owner_id
             WHERE a.user_id = :user_id AND s.deleted_at IS NULL';
        $params = ['user_id' => $userId];

        if ($titleContains !== null && $titleContains !== '') {
            $sql .= ' AND LOWER(s.title) LIKE LOWER(:title_contains) ESCAPE \'\\\\\'';
            $params['title_contains'] = $this->escapeTitleContains($titleContains);
        }

        $sql .= ' ORDER BY s.updated_at DESC';

        $stmt = Db::connection()->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll();
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
