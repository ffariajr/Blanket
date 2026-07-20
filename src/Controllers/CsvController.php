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
 * and attribution as any other edit. Grid shape is the canonical
 * {"cells": {"A1": {"value": "..."}}} schema (see CELL_SCHEMA.md) -- CSV
 * rows/columns are converted to/from A1-style cell references. Export
 * writes each cell's raw `value` (a formula's literal text, not a computed
 * result -- nothing server-side evaluates formulas).
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
        $cells = $this->rowsToCells($rows);
        $editorName = $request->input('editor_name');

        $sequence = $this->history->save(
            $tabId,
            ['cells' => (object) $cells],
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
        $cells = (array) ($current['data']['cells'] ?? []);
        $rows = $this->cellsToRows($cells);

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

    /**
     * @param list<list<string>> $rows
     * @return array<string,array{value:string}>
     */
    private function rowsToCells(array $rows): array
    {
        $cells = [];
        foreach ($rows as $r => $row) {
            foreach ($row as $c => $value) {
                if ($value === '' || $value === null) {
                    continue; // sparse: a blank cell has no key at all
                }
                $cells[$this->colIndexToLetter((int) $c) . ($r + 1)] = ['value' => (string) $value];
            }
        }
        return $cells;
    }

    /**
     * @param array<string,array{value?:string}> $cells
     * @return list<list<string>>
     */
    private function cellsToRows(array $cells): array
    {
        if ($cells === []) {
            return [];
        }

        $maxRow = 0;
        $maxCol = 0;
        $parsed = [];
        foreach ($cells as $ref => $cell) {
            [$col, $row] = $this->parseA1Ref((string) $ref);
            $parsed[] = [$col, $row, (string) ($cell['value'] ?? '')];
            $maxRow = max($maxRow, $row);
            $maxCol = max($maxCol, $col);
        }

        $grid = array_fill(0, $maxRow + 1, array_fill(0, $maxCol + 1, ''));
        foreach ($parsed as [$col, $row, $value]) {
            $grid[$row][$col] = $value;
        }
        return $grid;
    }

    private function colIndexToLetter(int $index): string
    {
        $letter = '';
        $index++;
        while ($index > 0) {
            $rem = ($index - 1) % 26;
            $letter = chr(65 + $rem) . $letter;
            $index = intdiv($index - 1, 26);
        }
        return $letter;
    }

    /** @return array{0:int,1:int} [0-based col, 0-based row] */
    private function parseA1Ref(string $ref): array
    {
        preg_match('/^([A-Z]+)(\d+)$/', $ref, $m);
        [, $letters, $rowStr] = $m + [null, '', '1'];

        $col = 0;
        foreach (str_split($letters) as $char) {
            $col = $col * 26 + (ord($char) - 64);
        }

        return [$col - 1, ((int) $rowStr) - 1];
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
