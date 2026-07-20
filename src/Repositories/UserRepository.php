<?php

declare(strict_types=1);

namespace Blanket\Repositories;

use Blanket\Db;

final class UserRepository
{
    /** @return array{id:int,username:string,email:string,password_hash:string,display_name:string,is_admin:bool,enabled:bool}|null */
    public function findByUsername(string $username): ?array
    {
        // id 0 (__anonymous__) must never be reachable through login,
        // regardless of what password_hash checks would otherwise do.
        if ($username === '__anonymous__') {
            return null;
        }

        $stmt = Db::connection()->prepare(
            'SELECT id, username, email, password_hash, display_name, is_admin, enabled
             FROM users
             WHERE username = :username AND deleted_at IS NULL'
        );
        $stmt->execute(['username' => $username]);
        $row = $stmt->fetch();
        if ($row === false) {
            return null;
        }

        $row['id'] = (int) $row['id'];
        $row['is_admin'] = (bool) $row['is_admin'];
        $row['enabled'] = (bool) $row['enabled'];
        return $row;
    }

    /**
     * Lean lookup for the "share with username X" flow -- deliberately
     * excludes password_hash/email/is_admin/enabled, which findByUsername()
     * returns but a sharing owner has no business learning about someone
     * else's account.
     *
     * @return array{id:int,username:string,display_name:string}|null
     */
    public function findPublicByUsername(string $username): ?array
    {
        if ($username === '__anonymous__') {
            return null;
        }

        $stmt = Db::connection()->prepare(
            'SELECT id, username, display_name
             FROM users
             WHERE username = :username AND deleted_at IS NULL'
        );
        $stmt->execute(['username' => $username]);
        $row = $stmt->fetch();
        if ($row === false) {
            return null;
        }

        $row['id'] = (int) $row['id'];
        return $row;
    }

    public function create(
        string $username,
        string $email,
        string $passwordHash,
        string $displayName,
        bool $isAdmin = false
    ): int {
        $stmt = Db::connection()->prepare(
            'INSERT INTO users (username, email, password_hash, display_name, is_admin)
             VALUES (:username, :email, :password_hash, :display_name, :is_admin)'
        );
        $stmt->execute([
            'username' => $username,
            'email' => $email,
            'password_hash' => $passwordHash,
            'display_name' => $displayName,
            'is_admin' => $isAdmin ? 1 : 0,
        ]);
        return (int) Db::connection()->lastInsertId();
    }
}
