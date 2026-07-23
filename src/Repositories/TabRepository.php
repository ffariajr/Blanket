<?php

declare(strict_types=1);

namespace Blanket\Repositories;

use Blanket\Db;

final class TabRepository
{
    /** @return array{id:int,spreadsheet_id:int,name:string,position:int,created_at:string,deleted_at:?string}|null */
    public function find(int $id): ?array
    {
        $stmt = Db::connection()->prepare(
            'SELECT id, spreadsheet_id, name, position, created_at, deleted_at
             FROM tabs WHERE id = :id AND deleted_at IS NULL'
        );
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch();
        return $row === false ? null : $this->cast($row);
    }

    /** Same as find(), but returns a soft-deleted tab too (needed to read deleted_by/created_by inference after deletion). */
    public function findIncludingDeleted(int $id): ?array
    {
        $stmt = Db::connection()->prepare(
            'SELECT id, spreadsheet_id, name, position, created_at, deleted_at
             FROM tabs WHERE id = :id'
        );
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch();
        return $row === false ? null : $this->cast($row);
    }

    public function listForSpreadsheet(int $spreadsheetId): array
    {
        $stmt = Db::connection()->prepare(
            'SELECT id, spreadsheet_id, name, position, created_at, deleted_at
             FROM tabs WHERE spreadsheet_id = :spreadsheet_id AND deleted_at IS NULL
             ORDER BY position ASC, id ASC'
        );
        $stmt->execute(['spreadsheet_id' => $spreadsheetId]);
        return array_map($this->cast(...), $stmt->fetchAll());
    }

    public function nextPosition(int $spreadsheetId): int
    {
        $stmt = Db::connection()->prepare(
            'SELECT COALESCE(MAX(position), -1) + 1 AS next_position
             FROM tabs WHERE spreadsheet_id = :spreadsheet_id'
        );
        $stmt->execute(['spreadsheet_id' => $spreadsheetId]);
        return (int) $stmt->fetch()['next_position'];
    }

    public function create(int $spreadsheetId, string $name, int $position): int
    {
        $stmt = Db::connection()->prepare(
            'INSERT INTO tabs (spreadsheet_id, name, position) VALUES (:spreadsheet_id, :name, :position)'
        );
        $stmt->execute(['spreadsheet_id' => $spreadsheetId, 'name' => $name, 'position' => $position]);
        return (int) Db::connection()->lastInsertId();
    }

    public function rename(int $id, string $name): void
    {
        $stmt = Db::connection()->prepare('UPDATE tabs SET name = :name WHERE id = :id');
        $stmt->execute(['name' => $name, 'id' => $id]);
    }

    /**
     * Moves tab $id to $targetPosition among its spreadsheet's active tabs,
     * shifting every tab strictly between the old and new position by one
     * to make room -- never just overwriting $id's position column, which
     * is how two tabs used to end up sharing a position (see
     * assets/js/app.js showManageTabs' old two-call swap and the comment
     * that used to sit here). $targetPosition is clamped into
     * [0, activeTabCount-1] so positions stay a contiguous 0..N-1
     * sequence with no gaps or collisions; the caller (TabController) is
     * still responsible for rejecting negative input outright with a 422
     * rather than silently clamping it.
     */
    public function reorder(int $id, int $spreadsheetId, int $targetPosition): void
    {
        $pdo = Db::connection();
        $pdo->beginTransaction();
        try {
            // Lock every active tab row in this spreadsheet for the
            // transaction's duration so a concurrent reorder (or a create/
            // delete that touches positions) can't interleave with the
            // shift below and reintroduce a collision.
            $lockStmt = $pdo->prepare(
                'SELECT id, position FROM tabs
                 WHERE spreadsheet_id = :spreadsheet_id AND deleted_at IS NULL
                 ORDER BY position ASC, id ASC
                 FOR UPDATE'
            );
            $lockStmt->execute(['spreadsheet_id' => $spreadsheetId]);
            $rows = $lockStmt->fetchAll();

            $activeCount = count($rows);
            $oldPosition = null;
            foreach ($rows as $row) {
                if ((int) $row['id'] === $id) {
                    $oldPosition = (int) $row['position'];
                    break;
                }
            }
            // Tab already gone or not part of this spreadsheet -- caller
            // already resolved it via find(), so this shouldn't happen, but
            // there's nothing sane to shift around if it does.
            if ($oldPosition === null) {
                $pdo->commit();
                return;
            }

            $targetPosition = max(0, min($targetPosition, $activeCount - 1));
            if ($targetPosition !== $oldPosition) {
                if ($targetPosition > $oldPosition) {
                    // Moving right: everything strictly after the old spot up
                    // through the target slides left by one to close the gap.
                    $shift = $pdo->prepare(
                        'UPDATE tabs SET position = position - 1
                         WHERE spreadsheet_id = :spreadsheet_id AND deleted_at IS NULL
                           AND position > :old_position AND position <= :target_position'
                    );
                } else {
                    // Moving left: everything from the target up through just
                    // before the old spot slides right by one.
                    $shift = $pdo->prepare(
                        'UPDATE tabs SET position = position + 1
                         WHERE spreadsheet_id = :spreadsheet_id AND deleted_at IS NULL
                           AND position >= :target_position AND position < :old_position'
                    );
                }
                $shift->execute([
                    'spreadsheet_id' => $spreadsheetId,
                    'old_position' => $oldPosition,
                    'target_position' => $targetPosition,
                ]);

                $update = $pdo->prepare('UPDATE tabs SET position = :position WHERE id = :id');
                $update->execute(['position' => $targetPosition, 'id' => $id]);
            }

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }

    /**
     * Marks the tab deleted. Caller MUST have already written the final
     * spreadsheet_history row (flushing current content, attributed to the
     * deleter) before calling this -- see HistoryRepository::save() -- and
     * must never write another history row for this tab_id afterward, or
     * the "who deleted this tab" inference (MAX(sequence)'s saved_by)
     * breaks. See db/schemas.md.
     */
    public function softDelete(int $id): void
    {
        $stmt = Db::connection()->prepare(
            'UPDATE tabs SET deleted_at = CURRENT_TIMESTAMP WHERE id = :id'
        );
        $stmt->execute(['id' => $id]);
    }

    /**
     * Locks the tab row for the duration of the current transaction, so
     * sequence-number allocation in HistoryRepository::save() is
     * serialized per-tab. Caller must already be inside a transaction.
     */
    public function lockForUpdate(int $id): void
    {
        $stmt = Db::connection()->prepare('SELECT id FROM tabs WHERE id = :id FOR UPDATE');
        $stmt->execute(['id' => $id]);
    }

    private function cast(array $row): array
    {
        $row['id'] = (int) $row['id'];
        $row['spreadsheet_id'] = (int) $row['spreadsheet_id'];
        $row['position'] = (int) $row['position'];
        return $row;
    }
}
