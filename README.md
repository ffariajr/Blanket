# Blanket

A lightweight, mobile-friendly spreadsheet application. Built as a self-hosted alternative to Google Sheets for users who want to edit spreadsheets on mobile without installing an app or signing into a Google account.

## Goals

- Simple spreadsheet editing that works well on mobile browsers
- Anonymous access without registration, controlled per spreadsheet by the owner
- Authenticated user accounts for ownership and access management
- Real-time collaborative editing
- Full edit history with the ability to restore previous versions

## Features

- Multiple sheets per spreadsheet (tabs)
- Basic formula support (SUM, AVG, MIN, MAX, COUNT, and similar)
- Basic cell formatting (bold, italic, colors)
- CSV import and export
- Per-spreadsheet anonymous access control: no access, view only, or view and edit
- Spreadsheets are not publicly listed; access is by URL
- Authenticated users can create, manage, and delete their own spreadsheets
- Authenticated users can grant other users view or edit access per spreadsheet

## UI

The interface adapts based on screen size and input method.

On mobile, the focus is simplicity: tap to edit, minimal chrome, touch-friendly controls.

On desktop, a fuller editing experience is available: multi-cell selection, drag to move cells, copy and paste, and standard spreadsheet keyboard interactions.

## Access Model

- Accounts are created by an administrator; self-registration is not supported
- Anonymous users can access a spreadsheet only if the owner has explicitly allowed it
- If a user is granted access in the access table, they can view at minimum
- A null user entry in the access table represents the anonymous access policy for that spreadsheet

## Tech Stack

- PHP with MySQL for data storage and page rendering
- Python WebSocket server for real-time collaboration
- Apache as the web server and reverse proxy
- JWT for authentication shared between PHP and the WebSocket server

## Data

- All spreadsheet data is stored as JSON
- Every save creates a new history entry; the current state is always the latest sequence
- Nothing is permanently deleted except by an administrator

## Hosting

Served at `church.dogmanjr.net/blanket`.
