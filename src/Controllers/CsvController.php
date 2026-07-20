<?php

declare(strict_types=1);

namespace Blanket\Controllers;

use Blanket\Auth\Authenticator;
use Blanket\Auth\Permissions;
use Blanket\Http\Request;
use Blanket\Http\Response;
use Blanket\Repositories\HistoryRepository;
use Blanket\Repositories\SpreadsheetRepository;
use Blanket\Repositories\TabRepository;

/**
 * CSV import is a normal save through HistoryRepository::save() -- not a
 * separate write path -- so it gets the same sequence allocation, locking,
 * and attribution as any other edit. Grid shape is the same simple
 * {"rows": [[...], ...]} convention used by TabController::create(); the
 * real cell/formula/formatting JSON schema is still TBD (frontend, task
 * #8), so this deliberately stays a plain 2D grid mapping, not a
 * formula-aware exporter.
 */
final class CsvController
{
    public function __construct(
        private readonly HistoryRepository $history = new HistoryRepository(),
        private readonly TabRepository $tabs = new TabRepository(),
        private readonly SpreadsheetRepository $spreadsheets = new SpreadsheetRepository(),
        private readonly Permissions $permissions = new Permissions(),
    ) {
    }

    public function import(Request $request): void
    {
        $user = Authenticator::resolve($request);
        $tabId = (int) $request->params['id'];
        [, $spreadsheet] = $this->requireTabAndSpreadsheet($tabId);

        if (!$this->permissions->canEdit($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

        $csv = $request->input('csv');
        if (!is_string($csv) || $csv === '') {
            Response::error('csv is required', 422);
        }

        $rows = $this->parseCsv($csv);
        $editorName = $request->input('editor_name');

        $sequence = $this->history->save(
            $tabId,
            ['rows' => $rows],
            $user,
            $request->clientIp(),
            is_string($editorName) ? $editorName : null,
        );

        Response::json(['sequence' => $sequence, 'rows' => count($rows)]);
    }

    public function export(Request $request): void
    {
        $user = Authenticator::resolve($request);
        $tabId = (int) $request->params['id'];
        [$tab, $spreadsheet] = $this->requireTabAndSpreadsheet($tabId);

        if (!$this->permissions->canView($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

        $current = $this->history->current($tabId);
        $rows = $current['data']['rows'] ?? [];

        $filename = preg_replace('/[^A-Za-z0-9_-]+/', '_', $tab['name']) . '.csv';
        Response::raw(
            $this->toCsv($rows),
            'text/csv; charset=utf-8',
            200,
            ['Content-Disposition' => "attachment; filename=\"{$filename}\""],
        );
    }

    /** @return list<list<string>> */
    private function parseCsv(string $csv): array
    {
        $handle = fopen('php://temp', 'r+');
        fwrite($handle, $csv);
        rewind($handle);

        $rows = [];
        while (($row = fgetcsv($handle)) !== false) {
            $rows[] = $row;
        }
        fclose($handle);
        return $rows;
    }

    /** @param list<list<string>> $rows */
    private function toCsv(array $rows): string
    {
        $handle = fopen('php://temp', 'r+');
        foreach ($rows as $row) {
            fputcsv($handle, $row);
        }
        rewind($handle);
        $csv = stream_get_contents($handle);
        fclose($handle);
        return $csv;
    }

    /** @return array{0:array,1:array} [tab, spreadsheet] */
    private function requireTabAndSpreadsheet(int $tabId): array
    {
        $tab = $this->tabs->find($tabId);
        if ($tab === null) {
            Response::error('Not found', 404);
        }
        $spreadsheet = $this->spreadsheets->find($tab['spreadsheet_id']);
        if ($spreadsheet === null) {
            Response::error('Not found', 404);
        }
        return [$tab, $spreadsheet];
    }
}
