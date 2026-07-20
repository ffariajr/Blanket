<?php

declare(strict_types=1);

namespace Blanket\Repositories;

use Blanket\Auth\CurrentUser;
use Blanket\Db;

final class HistoryRepository
{
    /** @return array{id:int,tab_id:int,sequence:int,data:mixed,saved_by:int,saved_by_name:string,created_at:string}|null */
    public function current(int $tabId): ?array
    {
        $stmt = Db::connection()->prepare(
            'SELECT id, tab_id, sequence, data, saved_by, saved_by_name, created_at
             FROM spreadsheet_history
             WHERE tab_id = :tab_id
             ORDER BY sequence DESC LIMIT 1'
        );
        $stmt->execute(['tab_id' => $tabId]);
        $row = $stmt->fetch();
        return $row === false ? null : $this->cast($row);
    }

    /** @return list<array{id:int,tab_id:int,sequence:int,saved_by:int,saved_by_name:string,created_at:string}> Newest first. Does not include `data` -- callers list metadata, then fetch a specific version's content via find(). */
    public function listForTab(int $tabId, int $limit = 50, int $offset = 0): array
    {
        $stmt = Db::connection()->prepare(
            'SELECT id, tab_id, sequence, saved_by, saved_by_name, created_at
             FROM spreadsheet_history
             WHERE tab_id = :tab_id
             ORDER BY sequence DESC
             LIMIT :limit OFFSET :offset'
        );
        $stmt->bindValue('tab_id', $tabId, \PDO::PARAM_INT);
        $stmt->bindValue('limit', $limit, \PDO::PARAM_INT);
        $stmt->bindValue('offset', $offset, \PDO::PARAM_INT);
        $stmt->execute();
        return array_map($this->cast(...), $stmt->fetchAll());
    }

    /** @return array{id:int,tab_id:int,sequence:int,data:mixed,saved_by:int,saved_by_name:string,created_at:string}|null */
    public function findBySequence(int $tabId, int $sequence): ?array
    {
        $stmt = Db::connection()->prepare(
            'SELECT id, tab_id, sequence, data, saved_by, saved_by_name, created_at
             FROM spreadsheet_history WHERE tab_id = :tab_id AND sequence = :sequence'
        );
        $stmt->execute(['tab_id' => $tabId, 'sequence' => $sequence]);
        $row = $stmt->fetch();
        return $row === false ? null : $this->cast($row);
    }

    /** saved_by of the row with MIN(sequence) for this tab -- "who created this tab" (see db/schemas.md). */
    public function creatorOf(int $tabId): ?array
    {
        $stmt = Db::connection()->prepare(
            'SELECT saved_by, saved_by_name FROM spreadsheet_history
             WHERE tab_id = :tab_id ORDER BY sequence ASC LIMIT 1'
        );
        $stmt->execute(['tab_id' => $tabId]);
        $row = $stmt->fetch();
        return $row === false ? null : ['saved_by' => (int) $row['saved_by'], 'saved_by_name' => $row['saved_by_name']];
    }

    /** saved_by of the row with MAX(sequence) for this tab -- only meaningful once the tab is actually deleted (see db/schemas.md). */
    public function deleterOf(int $tabId): ?array
    {
        $stmt = Db::connection()->prepare(
            'SELECT saved_by, saved_by_name FROM spreadsheet_history
             WHERE tab_id = :tab_id ORDER BY sequence DESC LIMIT 1'
        );
        $stmt->execute(['tab_id' => $tabId]);
        $row = $stmt->fetch();
        return $row === false ? null : ['saved_by' => (int) $row['saved_by'], 'saved_by_name' => $row['saved_by_name']];
    }

    /**
     * Writes a new history row for $tabId with the next sequence number,
     * inside its own transaction with the tab row locked for the duration
     * -- serializes sequence allocation per-tab, per the concurrency note
     * in db/migrations/0001. $data is stored as-is (schemaless from the
     * DB's perspective; the cell/grid JSON shape is an app-layer concern).
     *
     * saved_by_name follows the rule documented in db/schemas.md: server-
     * derived from the authenticated user's display name (never trusted
     * from the client), or the client-supplied self-reported name when the
     * actor is anonymous.
     */
    public function save(int $tabId, mixed $data, CurrentUser $actor, string $clientIp, ?string $selfReportedName = null): int
    {
        $savedByName = $actor->isAnonymous()
            ? ($selfReportedName !== null && $selfReportedName !== '' ? $selfReportedName : 'Anonymous')
            : $actor->displayName;

        $packedIp = @inet_pton($clientIp);
        if ($packedIp === false) {
            $packedIp = inet_pton('0.0.0.0');
        }

        $pdo = Db::connection();
        $pdo->beginTransaction();
        try {
            $pdo->prepare('SELECT id FROM tabs WHERE id = :id FOR UPDATE')->execute(['id' => $tabId]);

            $seqStmt = $pdo->prepare(
                'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM spreadsheet_history WHERE tab_id = :tab_id'
            );
            $seqStmt->execute(['tab_id' => $tabId]);
            $sequence = (int) $seqStmt->fetch()['next_sequence'];

            $insert = $pdo->prepare(
                'INSERT INTO spreadsheet_history (tab_id, sequence, data, saved_by, saved_by_ip, saved_by_name)
                 VALUES (:tab_id, :sequence, :data, :saved_by, :saved_by_ip, :saved_by_name)'
            );
            $insert->bindValue('tab_id', $tabId, \PDO::PARAM_INT);
            $insert->bindValue('sequence', $sequence, \PDO::PARAM_INT);
            $insert->bindValue('data', json_encode($data));
            $insert->bindValue('saved_by', $actor->id, \PDO::PARAM_INT);
            $insert->bindValue('saved_by_ip', $packedIp, \PDO::PARAM_LOB);
            $insert->bindValue('saved_by_name', $savedByName);
            $insert->execute();

            $pdo->commit();
            return $sequence;
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }

    private function cast(array $row): array
    {
        $row['id'] = (int) $row['id'];
        $row['tab_id'] = (int) $row['tab_id'];
        $row['sequence'] = (int) $row['sequence'];
        $row['saved_by'] = (int) $row['saved_by'];
        if (array_key_exists('data', $row)) {
            $row['data'] = json_decode($row['data'], true);
        }
        return $row;
    }
}
