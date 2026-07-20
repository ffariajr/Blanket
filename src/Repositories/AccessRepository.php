<?php

declare(strict_types=1);

namespace Blanket\Repositories;

use Blanket\Db;

/**
 * user_id = 0 is the anonymous access policy row for a spreadsheet (see
 * db/schemas.md) -- grant()/revoke() with userId 0 sets/clears it, same as
 * any other row. Absence of a row = no access.
 */
final class AccessRepository
{
    /** @return array{spreadsheet_id:int,user_id:int,access_level:string}|null */
    public function get(int $spreadsheetId, int $userId): ?array
    {
        $stmt = Db::connection()->prepare(
            'SELECT spreadsheet_id, user_id, access_level FROM spreadsheet_access
             WHERE spreadsheet_id = :spreadsheet_id AND user_id = :user_id'
        );
        $stmt->execute(['spreadsheet_id' => $spreadsheetId, 'user_id' => $userId]);
        $row = $stmt->fetch();
        return $row === false ? null : $this->cast($row);
    }

    /** @return list<array{spreadsheet_id:int,user_id:int,access_level:string,username:?string,display_name:?string}> */
    public function listForSpreadsheet(int $spreadsheetId): array
    {
        $stmt = Db::connection()->prepare(
            'SELECT a.spreadsheet_id, a.user_id, a.access_level, u.username, u.display_name
             FROM spreadsheet_access a
             LEFT JOIN users u ON u.id = a.user_id
             WHERE a.spreadsheet_id = :spreadsheet_id
             ORDER BY a.user_id = 0 DESC, a.created_at ASC'
        );
        $stmt->execute(['spreadsheet_id' => $spreadsheetId]);
        return array_map($this->cast(...), $stmt->fetchAll());
    }

    public function grant(int $spreadsheetId, int $userId, string $accessLevel): void
    {
        $stmt = Db::connection()->prepare(
            'INSERT INTO spreadsheet_access (spreadsheet_id, user_id, access_level)
             VALUES (:spreadsheet_id, :user_id, :access_level)
             ON DUPLICATE KEY UPDATE access_level = VALUES(access_level)'
        );
        $stmt->execute(['spreadsheet_id' => $spreadsheetId, 'user_id' => $userId, 'access_level' => $accessLevel]);
    }

    public function revoke(int $spreadsheetId, int $userId): void
    {
        $stmt = Db::connection()->prepare(
            'DELETE FROM spreadsheet_access WHERE spreadsheet_id = :spreadsheet_id AND user_id = :user_id'
        );
        $stmt->execute(['spreadsheet_id' => $spreadsheetId, 'user_id' => $userId]);
    }

    private function cast(array $row): array
    {
        $row['spreadsheet_id'] = (int) $row['spreadsheet_id'];
        $row['user_id'] = (int) $row['user_id'];
        return $row;
    }
}
