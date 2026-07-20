<?php

declare(strict_types=1);

namespace Blanket;

final class Db
{
    private static ?\PDO $pdo = null;

    public static function connection(): \PDO
    {
        if (self::$pdo !== null) {
            return self::$pdo;
        }

        $host = Config::get('HOST');
        $port = Config::get('DB_PORT');
        $name = Config::get('DB_NAME');
        $user = Config::get('USER');
        $pass = Config::get('PASSWORD');

        $dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";

        $pdo = new \PDO($dsn, $user, $pass, [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
            \PDO::ATTR_EMULATE_PREPARES => false,
            // mysqlnd only negotiates TLS at all if an SSL attribute is
            // set -- without this, the connection silently stays
            // plaintext and the blanket DB user's REQUIRE SSL grant
            // rejects it as "Access denied" (not a distinct TLS error).
            // We still don't verify the server cert chain since
            // db.dogmanjr.net uses MySQL's self-signed default CA.
            \PDO::MYSQL_ATTR_SSL_CA => '/etc/ssl/certs/ca-certificates.crt',
            \PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT => false,
            \PDO::MYSQL_ATTR_MULTI_STATEMENTS => false,
        ]);

        // Fail loudly if the server ever stops enforcing TLS on this
        // connection (the blanket DB user has REQUIRE SSL, but assert it
        // here too rather than trusting that silently).
        $cipher = $pdo->query("SHOW STATUS LIKE 'Ssl_cipher'")->fetch();
        if (empty($cipher['Value'])) {
            throw new \RuntimeException('Database connection is not using TLS');
        }

        self::$pdo = $pdo;
        return $pdo;
    }
}
